'use strict';

const { ObjectId } = require('mongodb');

/**
 * Service for mailbox operations
 */
class MailboxService {
    constructor(options) {
        this.db = options.db;
        this.redis = options.redis;
        this.logger = options.logger;
        this.mailboxHandler = options.mailboxHandler;
    }

    /**
     * Get all mailboxes for a user
     */
    async getMailboxList(userId, includeCounters = true) {
        const user = await this.db.users.collection('users').findOne(
            { _id: new ObjectId(userId) },
            { projection: { _id: 1, username: 1, name: 1 } }
        );

        if (!user) {
            throw new Error('User not found');
        }

        const mailboxes = await this.db.database.collection('mailboxes')
            .find({ user: new ObjectId(userId) })
            .sort({ path: 1 })
            .toArray();

        const result = [];
        for (const mailbox of mailboxes) {
            const mailboxData = {
                id: mailbox._id.toString(),
                name: mailbox.name,
                path: mailbox.path,
                specialUse: mailbox.specialUse || null,
                subscribed: mailbox.subscribed !== false,
                hidden: mailbox.hidden === true
            };

            if (includeCounters) {
                // Get message counts
                const stats = await this.db.database.collection('messages').aggregate([
                    { $match: { mailbox: mailbox._id, user: new ObjectId(userId) } },
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            unread: {
                                $sum: {
                                    $cond: [{ $in: ['\\Seen', '$flags'] }, 0, 1]
                                }
                            }
                        }
                    }
                ]).toArray();

                const counts = stats[0] || { total: 0, unread: 0 };
                mailboxData.messages = counts.total;
                mailboxData.unread = counts.unread;
            }

            result.push(mailboxData);
        }

        return {
            user: {
                id: user._id.toString(),
                username: user.username,
                name: user.name
            },
            mailboxes: result
        };
    }

    /**
     * Get mailbox by ID or path
     */
    async getMailbox(userId, mailboxIdentifier) {
        let query = { user: new ObjectId(userId) };

        // Check if it's an ObjectId or a path
        if (ObjectId.isValid(mailboxIdentifier)) {
            query._id = new ObjectId(mailboxIdentifier);
        } else {
            query.path = mailboxIdentifier;
        }

        const mailbox = await this.db.database.collection('mailboxes').findOne(query);
        if (!mailbox) {
            throw new Error('Mailbox not found');
        }

        return mailbox;
    }

    /**
     * Create a new mailbox
     */
    async createMailbox(userId, path) {
        if (!this.mailboxHandler) {
            throw new Error('MailboxHandler not available');
        }

        try {
            // Use mailboxHandler to create mailbox with proper validation and notifications
            const result = await this.mailboxHandler.createAsync(
                new ObjectId(userId),
                path,
                {
                    subscribed: true,
                    hidden: false
                }
            );

            return {
                id: result.id.toString(),
                path: path,
                name: path.split('/').pop(),
                created: result.status
            };
        } catch (err) {
            // Map handler errors to user-friendly messages
            if (err.code === 'UserNotFound') {
                throw new Error('User not found');
            } else if (err.code === 'ALREADYEXISTS') {
                throw new Error('Mailbox already exists');
            } else if (err.code === 'CANNOT') {
                throw new Error(err.message);
            }
            throw err;
        }
    }
}

module.exports = MailboxService;