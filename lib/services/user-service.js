'use strict';

const { ObjectId } = require('mongodb');

/**
 * Service for user operations
 */
class UserService {
    constructor(options) {
        this.db = options.db;
        this.redis = options.redis;
        this.logger = options.logger;
        this.userHandler = options.userHandler;
    }

    /**
     * Get user information
     */
    async getUserInfo(userId) {
        let user;
        
        if (this.userHandler) {
            // Use userHandler to get user with additional fields
            try {
                user = await this.userHandler.asyncGet(userId.toString(), {
                    username: true,
                    name: true,
                    address: true,
                    language: true,
                    quota: true,
                    storageUsed: true,
                    enabled: true,
                    suspended: true,
                    created: true
                });
            } catch (err) {
                throw new Error('User not found');
            }
        } else {
            // Fallback to direct database query
            user = await this.db.users.collection('users').findOne(
                { _id: new ObjectId(userId) },
                {
                    projection: {
                        _id: 1,
                        username: 1,
                        name: 1,
                        address: 1,
                        language: 1,
                        quota: 1,
                        storageUsed: 1,
                        enabled: 1,
                        suspended: 1,
                        created: 1
                    }
                }
            );
    
            if (!user) {
                throw new Error('User not found');
            }
        }
    
        // Get user addresses
        const addresses = await this.db.users.collection('addresses')
            .find({ user: new ObjectId(userId) })
            .toArray();
    
        // Get mailbox count
        const mailboxCount = await this.db.database.collection('mailboxes')
            .countDocuments({ user: new ObjectId(userId) });
    
        // Get message count
        const messageCount = await this.db.database.collection('messages')
            .countDocuments({ user: new ObjectId(userId) });
    
        return {
            id: user._id.toString(),
            username: user.username,
            name: user.name,
            addresses: addresses.map(addr => ({
                id: addr._id.toString(),
                address: addr.address,
                name: addr.name,
                main: addr.main === true
            })),
            quota: {
                allowed: user.quota || 0,
                used: user.storageUsed || 0
            },
            enabled: user.enabled !== false,
            suspended: user.suspended === true,
            created: user.created,
            stats: {
                mailboxes: mailboxCount,
                messages: messageCount
            }
        };
    }



    /**
     * Get recent messages across all mailboxes
     */
    async getRecentMessages(userId, mailboxFilter = null, limit = 20) {
        const query = { user: new ObjectId(userId) };

        // Add mailbox filter if specified
        if (mailboxFilter) {
            let mailboxDoc;
            if (ObjectId.isValid(mailboxFilter)) {
                mailboxDoc = await this.db.database.collection('mailboxes').findOne({
                    _id: new ObjectId(mailboxFilter),
                    user: new ObjectId(userId)
                });
            } else {
                mailboxDoc = await this.db.database.collection('mailboxes').findOne({
                    path: mailboxFilter,
                    user: new ObjectId(userId)
                });
            }

            if (mailboxDoc) {
                query.mailbox = mailboxDoc._id;
            }
        }

        // Use MessageService for formatting
        const MessageService = require('./message-service');
        const messageService = new MessageService({
            db: this.db,
            redis: this.redis,
            logger: this.logger
        });

        // Use projection - no body needed for recent messages
        const projection = messageService.getMessageProjection({
            includeBody: false,
            includeIntro: true // Include preview for recent messages
        });

        const messages = await this.db.database.collection('messages')
            .find(query, { projection })
            .sort({ idate: -1 })
            .limit(limit)
            .toArray();

        // Preload all mailboxes
        const mailboxIds = [...new Set(messages.map(m => m.mailbox.toString()))];
        const mailboxes = await this.db.database.collection('mailboxes')
            .find({ _id: { $in: mailboxIds.map(id => new ObjectId(id)) } })
            .toArray();
        const mailboxMap = new Map(mailboxes.map(mb => [mb._id.toString(), mb]));

        const result = [];
        for (const message of messages) {
            const mailbox = mailboxMap.get(message.mailbox.toString());
            if (!mailbox) continue;
            
            const formatted = await messageService.formatMessage(message, mailbox, {
                includeBody: false
            });
            result.push(formatted);
        }

        return {
            messages: result,
            total: result.length
        };
    }
}

module.exports = UserService;