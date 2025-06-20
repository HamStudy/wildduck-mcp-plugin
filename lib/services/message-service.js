'use strict';

const { ObjectId } = require('mongodb');
const TurndownService = require('turndown');

// Standard projection for message queries
const MESSAGE_PROJECTION = {
    _id: 1,
    uid: 1,
    mailbox: 1,
    thread: 1,
    subject: 1,
    headers: 1,  // Contains parsed headers like from, to, date, etc
    idate: 1,
    hdate: 1,
    flags: 1,
    size: 1,
    ha: 1,
    attachments: 1,  // Attachment metadata array
    mimeTree: 1,     // Needed for attachment mapping
    unseen: 1,
    flagged: 1,
    draft: 1,
    deleted: 1,
    msgid: 1,
    modseq: 1,
    // Include these only when needed
    text: 1,
    html: 1,
    intro: 1  // Preview text
};

/**
 * Service for message operations
 */
class MessageService {
    constructor(options) {
        this.db = options.db;
        this.redis = options.redis;
        this.logger = options.logger;
        this.messageHandler = options.messageHandler;
        this.mailboxHandler = options.mailboxHandler;
        this.attachmentService = options.attachmentService;
        
        // Initialize Turndown for HTML to Markdown conversion
        this.turndown = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            bulletListMarker: '-'
        });
    }

    /**
     * Get projection for message queries
     * @param {Object} options - Options for projection
     * @param {boolean} options.includeBody - Include text/html fields
     * @param {boolean} options.includeIntro - Include intro (preview) field
     * @returns {Object} MongoDB projection
     */
    getMessageProjection(options = {}) {
        const projection = { ...MESSAGE_PROJECTION };
        
        if (!options.includeBody) {
            delete projection.text;
            delete projection.html;
        }
        
        if (!options.includeIntro) {
            delete projection.intro;
        }
        
        return projection;
    }

    /**
     * Format a message for API response
     * @param {Object} message - Raw message from database
     * @param {Object} mailbox - Mailbox document (optional, will be fetched if not provided)
     * @param {Object} options - Formatting options
     * @param {boolean} options.includeBody - Include text/html body
     * @returns {Object} Formatted message for API response
     */
    async formatMessage(message, mailbox = null, options = {}) {
        // Get mailbox if not provided
        if (!mailbox) {
            mailbox = await this.db.database.collection('mailboxes').findOne({
                _id: message.mailbox
            });
        }

        // Extract headers
        const headers = message.headers || {};

        // Base message data
        const formatted = {
            id: message._id.toString(),
            uid: message.uid,
            mailbox: {
                id: mailbox._id.toString(),
                path: mailbox.path,
                name: mailbox.name
            },
            thread: message.thread,
            modseq: message.modseq,
            
            // Headers - leave addresses as-is
            subject: message.subject || headers.subject || '(no subject)',
            from: headers.from || null,
            to: headers.to || [],
            cc: headers.cc || [],
            bcc: headers.bcc || [],
            replyTo: headers['reply-to'] || null,
            
            // Dates
            date: message.idate || message.hdate,
            headerDate: headers.date,
            
            // Message IDs
            messageId: message.msgid || headers['message-id'],
            inReplyTo: headers['in-reply-to'],
            references: headers.references,
            
            // Flags and status
            flags: message.flags || [],
            size: message.size || 0,
            hasAttachments: message.ha === true,
            seen: !message.unseen,
            flagged: message.flagged === true,
            draft: message.draft === true,
            deleted: message.deleted === true,
            
            // Preview
            intro: message.intro
        };

        // Add body if requested
        if (options.includeBody) {
            if (message.text) {
                // Prefer plain text if available
                formatted.body = typeof message.text === 'string'
                    ? message.text
                    : message.text.toString('utf8');
            } else if (message.html) {
                // Convert HTML to Markdown if no plain text
                try {
                    // Ensure HTML is a string (might be a Buffer)
                    const htmlString = typeof message.html === 'string' 
                        ? message.html 
                        : message.html.toString('utf8');
                    formatted.body = this.turndown.turndown(htmlString);
                } catch (err) {
                    this.logger.error('Failed to convert HTML to Markdown', err);
                    // Fallback to raw HTML
                    formatted.body = typeof message.html === 'string' 
                        ? message.html 
                        : message.html.toString('utf8');
                }
            }
        }

        // Add other headers if requested
        if (options.includeHeaders) {
            formatted.headers = headers;
        }

        // Handle attachments
        if (message.ha && message.attachments && this.attachmentService) {
            const baseUrl = options?._req ? 
                `${options._req.headers['x-forwarded-proto'] || 'http'}://${options._req.headers.host}` : 
                'http://localhost:8080';

            // Get attachment map from mimeTree if available
            const attachmentMap = message.mimeTree?.attachmentMap || {};

            formatted.attachments = message.attachments.map(att => {
                // Get the GridFS ID from the attachment map
                const gridfsId = attachmentMap[att.id] || att.id;
                
                return {
                    id: att.id,
                    filename: att.filename,
                    contentType: att.contentType,
                    size: att.size,
                    sizeKb: att.sizeKb,
                    disposition: att.disposition || 'attachment',
                    transferEncoding: att.transferEncoding,
                    related: att.related,
                    gridfsId: gridfsId.toString(), // Include GridFS ID for reference
                    secureUrl: this.attachmentService.generateSecureAttachmentUrl(
                        message._id.toString(),
                        att.id,
                        att.filename,
                        baseUrl
                    )
                };
            });
        } else {
            formatted.attachments = [];
        }

        return formatted;
    }

    /**
     * Get messages from a mailbox
     */
    async getMessages(userId, options = {}) {
        const {
            mailbox = 'INBOX',
            limit = 20,
            page = 1,
            includeBodies = false
        } = options;

        // Get mailbox
        let mailboxDoc;
        if (ObjectId.isValid(mailbox)) {
            mailboxDoc = await this.db.database.collection('mailboxes').findOne({
                _id: new ObjectId(mailbox),
                user: new ObjectId(userId)
            });
        } else {
            mailboxDoc = await this.db.database.collection('mailboxes').findOne({
                path: mailbox,
                user: new ObjectId(userId)
            });
        }

        if (!mailboxDoc) {
            throw new Error('Mailbox not found');
        }

        const skip = (page - 1) * limit;

        // Build projection
        const projection = this.getMessageProjection({
            includeBody: includeBodies,
            includeIntro: false // Not needed for listing
        });

        // Build aggregation pipeline with projection
        const pipeline = [
            { $match: { mailbox: mailboxDoc._id, user: new ObjectId(userId) } },
            { $sort: { uid: -1 } },
            { $skip: skip },
            { $limit: limit },
            { $project: projection }
        ];

        const messages = await this.db.database.collection('messages')
            .aggregate(pipeline)
            .toArray();

        // Format all messages
        const result = [];
        for (const message of messages) {
            const formatted = await this.formatMessage(message, mailboxDoc, {
                includeBody: includeBodies
            });
            result.push(formatted);
        }

        return {
            mailbox: {
                id: mailboxDoc._id.toString(),
                path: mailboxDoc.path,
                name: mailboxDoc.name
            },
            messages: result,
            page,
            limit,
            total: await this.db.database.collection('messages').countDocuments({
                mailbox: mailboxDoc._id
            })
        };
    }

    /**
     * Get a specific message by ID or UID
     */
    async getMessage(userId, messageId, options = {}) {
        const {
            includeBody = true,
            includeAttachments = true
        } = options;

        // Build projection
        const projection = this.getMessageProjection({
            includeBody,
            includeIntro: true // Include preview for single message
        });

        // Build query - support both UID and ObjectId
        const query = { user: new ObjectId(userId) };
        
        // Check if messageId is a UID (numeric and < 10 chars)
        if (/^\d+$/.test(messageId) && messageId.length < 10) {
            query.uid = parseInt(messageId, 10);
        } else {
            query._id = new ObjectId(messageId);
        }

        const message = await this.db.database.collection('messages').findOne(
            query,
            { projection }
        );

        if (!message) {
            throw new Error('Message not found');
        }

        // Get mailbox info
        const mailbox = await this.db.database.collection('mailboxes').findOne({
            _id: message.mailbox,
            user: new ObjectId(userId)
        });

        if (!mailbox) {
            throw new Error('Mailbox not found');
        }

        const result = await this.formatMessage(message, mailbox, {
            includeBody,
            _req: options?._req
        });

        return result;
    }

    /**
     * Search messages
     */
    async searchMessages(userId, options = {}) {
        const {
            query,
            mailbox,
            limit = 10
        } = options;

        const searchCriteria = { user: new ObjectId(userId) };

        // Add mailbox filter if specified
        if (mailbox) {
            let mailboxDoc;
            if (ObjectId.isValid(mailbox)) {
                mailboxDoc = await this.db.database.collection('mailboxes').findOne({
                    _id: new ObjectId(mailbox),
                    user: new ObjectId(userId)
                });
            } else {
                mailboxDoc = await this.db.database.collection('mailboxes').findOne({
                    path: mailbox,
                    user: new ObjectId(userId)
                });
            }

            if (mailboxDoc) {
                searchCriteria.mailbox = mailboxDoc._id;
            }
        }

        // Add text search if query provided
        if (query) {
            searchCriteria.$text = { $search: query };
        }

        // Use projection for search
        const projection = this.getMessageProjection({
            includeBody: false,
            includeIntro: true // Include preview for search results
        });

        const messages = await this.db.database.collection('messages')
            .find(searchCriteria, { projection })
            .sort({ idate: -1 })
            .limit(limit)
            .toArray();

        // Preload all mailboxes for efficiency
        const mailboxIds = [...new Set(messages.map(m => m.mailbox.toString()))];
        const mailboxes = await this.db.database.collection('mailboxes')
            .find({ _id: { $in: mailboxIds.map(id => new ObjectId(id)) } })
            .toArray();
        const mailboxMap = new Map(mailboxes.map(mb => [mb._id.toString(), mb]));

        const result = [];
        for (const message of messages) {
            const mailboxDoc = mailboxMap.get(message.mailbox.toString());
            if (!mailboxDoc) continue;
            
            const formatted = await this.formatMessage(message, mailboxDoc, {
                includeBody: false
            });
            result.push(formatted);
        }

        return {
            query,
            results: result,
            total: result.length
        };
    }

    /**
     * Update message flags
     */
    async updateMessageFlags(userId, messageId, flags, action = 'set') {
        // Build query - support both UID and ObjectId
        const query = { user: new ObjectId(userId) };
        
        // Check if messageId is a UID (numeric and < 10 chars)
        if (/^\d+$/.test(messageId) && messageId.length < 10) {
            query.uid = parseInt(messageId, 10);
        } else {
            query._id = new ObjectId(messageId);
        }

        const message = await this.db.database.collection('messages').findOne(query);

        if (!message) {
            throw new Error('Message not found');
        }

        // Get mailbox for handler operations
        const mailbox = await this.db.database.collection('mailboxes').findOne({
            _id: message.mailbox,
            user: new ObjectId(userId)
        });

        if (!mailbox) {
            throw new Error('Mailbox not found');
        }

        if (this.messageHandler) {
            // Use messageHandler for proper flag updates with notifications
            const update = {};
            if (action === 'add') {
                update.$addToSet = { flags: { $each: flags } };
            } else if (action === 'remove') {
                update.$pull = { flags: { $in: flags } };
            } else {
                update.$set = { flags: flags };
            }

            await this.messageHandler.updateMessage({
                user: new ObjectId(userId),
                mailbox: mailbox._id,
                message: message._id,
                uid: message.uid
            }, update);
        } else {
            // Fallback to direct database update
            let updateQuery;
            if (action === 'add') {
                updateQuery = { $addToSet: { flags: { $each: flags } } };
            } else if (action === 'remove') {
                updateQuery = { $pullAll: { flags: flags } };
            } else {
                updateQuery = { $set: { flags: flags } };
            }

            await this.db.database.collection('messages').updateOne(
                { _id: new ObjectId(messageId) },
                updateQuery
            );
        }

        return { success: true };
    }

    /**
     * Move message to different mailbox
     */
    async moveMessage(userId, messageId, targetMailboxId) {
        // Build query - support both UID and ObjectId
        const query = { user: new ObjectId(userId) };
        
        // Check if messageId is a UID (numeric and < 10 chars)
        if (/^\d+$/.test(messageId) && messageId.length < 10) {
            query.uid = parseInt(messageId, 10);
        } else {
            query._id = new ObjectId(messageId);
        }

        const message = await this.db.database.collection('messages').findOne(query);

        if (!message) {
            throw new Error('Message not found');
        }

        // Get source mailbox
        const sourceMailbox = await this.db.database.collection('mailboxes').findOne({
            _id: message.mailbox,
            user: new ObjectId(userId)
        });

        if (!sourceMailbox) {
            throw new Error('Source mailbox not found');
        }

        // Verify target mailbox exists and user owns it
        const targetMailbox = await this.db.database.collection('mailboxes').findOne({
            _id: new ObjectId(targetMailboxId),
            user: new ObjectId(userId)
        });

        if (!targetMailbox) {
            throw new Error('Target mailbox not found');
        }

        if (this.messageHandler) {
            // Use messageHandler for proper move with notifications
            await this.messageHandler.moveAsync({
                source: {
                    user: new ObjectId(userId),
                    mailbox: sourceMailbox._id
                },
                destination: {
                    user: new ObjectId(userId),
                    mailbox: new ObjectId(targetMailboxId)
                },
                messages: [message._id],
                markAsSeen: false
            });
        } else {
            // Fallback to direct database update
            await this.db.database.collection('messages').updateOne(
                { _id: new ObjectId(messageId) },
                { $set: { mailbox: new ObjectId(targetMailboxId) } }
            );
        }

        return { success: true };
    }

    /**
     * Get message thread
     */
    async getThread(userId, messageId, includeBody = false) {
        // Build query - support both UID and ObjectId
        const query = { user: new ObjectId(userId) };
        
        // Check if messageId is a UID (numeric and < 10 chars)
        if (/^\d+$/.test(messageId) && messageId.length < 10) {
            query.uid = parseInt(messageId, 10);
        } else {
            query._id = new ObjectId(messageId);
        }

        // Use minimal projection for initial lookup
        const message = await this.db.database.collection('messages').findOne(
            query,
            { projection: { mailbox: 1, thread: 1, user: 1 } }
        );

        if (!message) {
            throw new Error('Message not found');
        }

        // Build projection for thread messages
        const projection = this.getMessageProjection({
            includeBody,
            includeIntro: true // Include preview for thread messages
        });

        let threadMessages;

        // If message has a thread ID, get all messages in that thread
        if (message.thread) {
            threadMessages = await this.db.database.collection('messages')
                .find(
                    {
                        user: new ObjectId(userId),
                        thread: message.thread
                    },
                    { projection }
                )
                .sort({ idate: 1 })
                .toArray();
        } else {
            // No thread ID means it's a single message thread - fetch full message
            threadMessages = await this.db.database.collection('messages')
                .find(
                    { _id: message._id },
                    { projection }
                )
                .toArray();
        }

        // Preload all mailboxes
        const mailboxIds = [...new Set(threadMessages.map(m => m.mailbox.toString()))];
        const mailboxes = await this.db.database.collection('mailboxes')
            .find({ _id: { $in: mailboxIds.map(id => new ObjectId(id)) } })
            .toArray();
        const mailboxMap = new Map(mailboxes.map(mb => [mb._id.toString(), mb]));

        const result = [];
        for (const msg of threadMessages) {
            const msgMailbox = mailboxMap.get(msg.mailbox.toString());
            if (!msgMailbox) continue;
            
            const formatted = await this.formatMessage(msg, msgMailbox, {
                includeBody
            });
            result.push(formatted);
        }

        return {
            thread: result,
            total: result.length
        };
    }

    /**
     * Delete message (move to Trash or permanent delete)
     */
    async deleteMessage(userId, messageId, permanently = false) {
        // Build query - support both UID and ObjectId
        const query = { user: new ObjectId(userId) };
        
        // Check if messageId is a UID (numeric and < 10 chars)
        if (/^\d+$/.test(messageId) && messageId.length < 10) {
            query.uid = parseInt(messageId, 10);
        } else {
            query._id = new ObjectId(messageId);
        }

        const message = await this.db.database.collection('messages').findOne(query);

        if (!message) {
            throw new Error('Message not found');
        }

        if (permanently) {
            // Permanent delete
            await this.db.database.collection('messages').deleteOne({
                _id: message._id
            });
        } else {
            // Move to Trash
            const trashMailbox = await this.db.database.collection('mailboxes').findOne({
                user: new ObjectId(userId),
                specialUse: '\\Trash'
            });

            if (trashMailbox) {
                await this.db.database.collection('messages').updateOne(
                    { _id: message._id },
                    { $set: { mailbox: trashMailbox._id } }
                );
            } else {
                // No trash mailbox, permanent delete
                await this.db.database.collection('messages').deleteOne({
                    _id: message._id
                });
            }
        }

        return { success: true };
    }
}

module.exports = MessageService;
module.exports.MESSAGE_PROJECTION = MESSAGE_PROJECTION;