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
    'mimeTree.parsedHeader': 1,  // Contains parsed headers as an object
    'mimeTree.attachmentMap': 1, // Needed for attachment mapping
    headers: 1,  // Raw headers array - fallback if parsedHeader not available
    idate: 1,
    hdate: 1,
    flags: 1,
    size: 1,
    ha: 1,
    attachments: 1,  // Attachment metadata array
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
 * Convert headers array to object if needed
 * @param {Array|Object} headers - Headers array or object
 * @returns {Object} Headers as object
 */
function headersArrayToObject(headers) {
    if (!headers) {
        return {};
    }
    
    // If already an object, return as-is
    if (!Array.isArray(headers)) {
        return headers;
    }
    
    // Convert array of {key, value} to object
    const result = {};
    headers.forEach(header => {
        if (header && header.key) {
            const key = header.key.toLowerCase();
            if (!result[key]) {
                result[key] = header.value;
            } else if (Array.isArray(result[key])) {
                result[key].push(header.value);
            } else {
                result[key] = [result[key], header.value];
            }
        }
    });
    return result;
}

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

        // Extract headers from parsedHeader in mimeTree
        let parsedHeader = (message.mimeTree && message.mimeTree.parsedHeader) || {};
        
        // Fallback to headers array if parsedHeader is empty
        if (Object.keys(parsedHeader).length === 0 && message.headers) {
            parsedHeader = headersArrayToObject(message.headers);
        }

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
            
            // Headers - use parsedHeader for properly parsed email addresses
            subject: message.subject || parsedHeader.subject || '(no subject)',
            from: parsedHeader.from ? [].concat(parsedHeader.from)[0] : null,
            to: [].concat(parsedHeader.to || []),
            cc: [].concat(parsedHeader.cc || []),
            bcc: [].concat(parsedHeader.bcc || []),
            replyTo: parsedHeader['reply-to'] ? [].concat(parsedHeader['reply-to'])[0] : null,
            
            // Dates
            date: message.idate || message.hdate,
            headerDate: parsedHeader.date,
            
            // Message IDs
            messageId: message.msgid || parsedHeader['message-id'],
            inReplyTo: parsedHeader['in-reply-to'],
            references: parsedHeader.references ? 
                (typeof parsedHeader.references === 'string' ? 
                    parsedHeader.references.split(/\s+/).filter(ref => ref) : 
                    parsedHeader.references) : 
                [],

            spamScore: parsedHeader['x-spam-score'] || 0,
            
            // Flags and status
            flags: message.flags || [],
            size: message.size || 0,
            hasAttachments: (message.attachments && message.attachments.length > 0) || false,
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
            formatted.headers = parsedHeader;
        }

        // Handle attachments - check attachments array, not just ha flag
        if (message.attachments && message.attachments.length > 0 && this.attachmentService) {
            let baseUrl;
            if (options?._req) {
                const req = options._req;
                const proto = req.headers['x-forwarded-proto'] || 'http';
                // Use x-forwarded-host if available (from proxy), otherwise use host
                const host = req.headers['x-forwarded-host'] || req.headers.host;
                baseUrl = `${proto}://${host}`;
                
                this.logger.verbose('MCP-MESSAGE', 'Generating attachment URLs with baseUrl=%s (proto=%s, forwarded-host=%s, host=%s)', 
                    baseUrl, proto, req.headers['x-forwarded-host'], req.headers.host);
            } else if (this.config?.apiUrl) {
                // Use configured API URL if available
                baseUrl = this.config.apiUrl;
                this.logger.verbose('MCP-MESSAGE', 'Using configured apiUrl for attachments: %s', baseUrl);
            } else {
                baseUrl = 'http://localhost:8080';
                this.logger.verbose('MCP-MESSAGE', 'Using default baseUrl for attachments: %s', baseUrl);
            }

            // Get attachment map from mimeTree if available
            const attachmentMap = message.mimeTree?.attachmentMap || {};
            
            // Log for debugging
            if (Object.keys(attachmentMap).length === 0 && message.attachments.length > 0) {
                this.logger.warn('MCP-MESSAGE', 'Message %s has attachments but no attachmentMap', message._id);
            }

            formatted.attachments = message.attachments.map(att => {
                // Get the GridFS ID from the attachment map
                let gridfsId = attachmentMap[att.id];
                
                if (!gridfsId) {
                    this.logger.warn('MCP-MESSAGE', 'No GridFS ID found for attachment %s in message %s', att.id, message._id);
                    // Fallback: try to use the attachment ID directly if it looks like an ObjectId
                    if (att.id && att.id.length === 24) {
                        gridfsId = att.id;
                    }
                }
                
                const attachment = {
                    filename: att.filename || 'attachment',
                    contentType: att.contentType || 'application/octet-stream',
                    size: att.size || 0
                };
                
                // Only add secure URL if we have a valid GridFS ID
                if (gridfsId) {
                    attachment.secureUrl = this.attachmentService.generateSecureAttachmentUrl(
                        message._id.toString(),
                        att.id,
                        att.filename || 'attachment',
                        baseUrl
                    );
                }
                
                return attachment;
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
                includeBody: includeBodies,
                _req: options._req
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
            includeBody = true
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
     * Search messages using WildDuck's search API
     */
    async searchMessages(userId, options = {}) {
        const prepareSearchFilter = require('../prepare-search-filter').prepareSearchFilter;
        
        // Prepare payload for WildDuck search
        const payload = {
            query: options.query,
            from: options.from,
            to: options.to,
            subject: options.subject,
            mailbox: options.mailbox,
            thread: options.thread,
            datestart: options.dateStart ? new Date(options.dateStart) : undefined,
            dateend: options.dateEnd ? new Date(options.dateEnd) : undefined,
            minSize: options.minSize,
            maxSize: options.maxSize,
            attachments: options.attachments,
            flagged: options.flagged,
            unseen: options.unseen,
            searchable: options.searchable !== false // Default to true
        };

        // Clean undefined values
        Object.keys(payload).forEach(key => {
            if (payload[key] === undefined) {
                delete payload[key];
            }
        });

        // Use WildDuck's prepare search filter
        const { filter } = await prepareSearchFilter(this.db, new ObjectId(userId), payload);

        const limit = options.limit || 20;
        const page = options.page || 1;
        const skip = (page - 1) * limit;

        // Get total count
        const total = await this.db.database.collection('messages').countDocuments(filter);

        // Use projection for efficiency
        const projection = this.getMessageProjection({
            includeBody: false,
            includeIntro: true
        });

        // Add thread info to projection if requested
        if (options.threadCounters) {
            projection.thread = true;
        }

        // Get messages
        const messages = await this.db.database.collection('messages')
            .find(filter, { projection })
            .sort({ idate: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Get thread counts if requested
        let threadCounts = new Map();
        if (options.threadCounters && messages.length > 0) {
            const threadIds = [...new Set(messages.map(m => m.thread))].filter(Boolean);
            if (threadIds.length > 0) {
                const counts = await this.db.database.collection('messages')
                    .aggregate([
                        {
                            $match: {
                                user: new ObjectId(userId),
                                thread: { $in: threadIds }
                            }
                        },
                        {
                            $group: {
                                _id: '$thread',
                                count: { $sum: 1 }
                            }
                        }
                    ])
                    .toArray();
                
                counts.forEach(c => threadCounts.set(c._id.toString(), c.count));
            }
        }

        // Preload mailboxes
        const mailboxIds = [...new Set(messages.map(m => m.mailbox.toString()))];
        const mailboxes = await this.db.database.collection('mailboxes')
            .find({ _id: { $in: mailboxIds.map(id => new ObjectId(id)) } })
            .toArray();
        const mailboxMap = new Map(mailboxes.map(mb => [mb._id.toString(), mb]));

        const results = [];
        for (const message of messages) {
            const mailboxDoc = mailboxMap.get(message.mailbox.toString());
            if (!mailboxDoc) continue;
            
            const formatted = await this.formatMessage(message, mailboxDoc, {
                includeBody: false
            });
            
            // Add thread count if available
            if (options.threadCounters && message.thread) {
                formatted.threadMessageCount = threadCounts.get(message.thread.toString()) || 1;
            }
            
            results.push(formatted);
        }

        return {
            total,
            page,
            pages: Math.ceil(total / limit),
            results
        };
    }

    /**
     * Search with OR conditions
     */
    async searchMessagesOr(userId, options = {}) {
        const prepareSearchFilter = require('../prepare-search-filter').prepareSearchFilter;
        
        // Prepare payload with OR conditions
        const payload = {
            or: options.or || {},
            mailbox: options.mailbox,
            datestart: options.dateStart ? new Date(options.dateStart) : undefined,
            dateend: options.dateEnd ? new Date(options.dateEnd) : undefined,
            attachments: options.attachments,
            searchable: true
        };

        // Clean undefined values
        Object.keys(payload).forEach(key => {
            if (payload[key] === undefined) {
                delete payload[key];
            }
        });

        // Use WildDuck's prepare search filter
        const { filter } = await prepareSearchFilter(this.db, new ObjectId(userId), payload);

        const limit = options.limit || 20;
        const page = options.page || 1;
        const skip = (page - 1) * limit;

        // Get total count
        const total = await this.db.database.collection('messages').countDocuments(filter);

        // Use projection
        const projection = this.getMessageProjection({
            includeBody: false,
            includeIntro: true
        });

        // Get messages
        const messages = await this.db.database.collection('messages')
            .find(filter, { projection })
            .sort({ idate: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Preload mailboxes
        const mailboxIds = [...new Set(messages.map(m => m.mailbox.toString()))];
        const mailboxes = await this.db.database.collection('mailboxes')
            .find({ _id: { $in: mailboxIds.map(id => new ObjectId(id)) } })
            .toArray();
        const mailboxMap = new Map(mailboxes.map(mb => [mb._id.toString(), mb]));

        const results = [];
        for (const message of messages) {
            const mailboxDoc = mailboxMap.get(message.mailbox.toString());
            if (!mailboxDoc) continue;
            
            const formatted = await this.formatMessage(message, mailboxDoc, {
                includeBody: false
            });
            results.push(formatted);
        }

        return {
            total,
            page,
            pages: Math.ceil(total / limit),
            or: options.or,
            results
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
                update.$set = { flags };
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
                updateQuery = { $pullAll: { flags } };
            } else {
                updateQuery = { $set: { flags } };
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
     * Get multiple messages by their IDs
     */
    async getMultipleMessages(userId, messageIds, options = {}) {
        const {
            includeBody = true
        } = options;

        // Validate and convert message IDs
        const messageQueries = messageIds.map(id => {
            // Support both UID and ObjectId formats
            if (/^\d+$/.test(id) && id.length < 10) {
                return { uid: parseInt(id, 10), user: new ObjectId(userId) };
            } else {
                return { _id: new ObjectId(id), user: new ObjectId(userId) };
            }
        });

        // Build projection
        const projection = this.getMessageProjection({
            includeBody,
            includeIntro: true
        });

        // Fetch all messages in one query
        const messages = await this.db.database.collection('messages')
            .find({ 
                $or: messageQueries
            }, { projection })
            .toArray();

        // Get all unique mailbox IDs
        const mailboxIds = [...new Set(messages.map(m => m.mailbox.toString()))];
        const mailboxes = await this.db.database.collection('mailboxes')
            .find({ 
                _id: { $in: mailboxIds.map(id => new ObjectId(id)) },
                user: new ObjectId(userId)
            })
            .toArray();
        const mailboxMap = new Map(mailboxes.map(mb => [mb._id.toString(), mb]));

        // Format all messages
        const results = [];
        for (const message of messages) {
            const mailboxDoc = mailboxMap.get(message.mailbox.toString());
            if (!mailboxDoc) continue;
            
            const formatted = await this.formatMessage(message, mailboxDoc, {
                includeBody,
                _req: options._req
            });
            results.push(formatted);
        }

        // Return in the same order as requested if possible
        const orderedResults = [];
        const notFound = [];
        
        for (const requestedId of messageIds) {
            const found = results.find(msg => {
                // Match by either MongoDB ID or UID
                if (/^\d+$/.test(requestedId) && requestedId.length < 10) {
                    return msg.uid === parseInt(requestedId, 10);
                } else {
                    return msg.id === requestedId;
                }
            });
            
            if (found) {
                orderedResults.push(found);
            } else {
                notFound.push(requestedId);
            }
        }

        return {
            messages: orderedResults,
            notFound: notFound.length > 0 ? notFound : undefined,
            total: orderedResults.length
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