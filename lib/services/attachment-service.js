'use strict';

const { ObjectId } = require('mongodb');
const crypto = require('crypto');


function signData(data, secret) {
    const dataToSign = data.join(':');
    const signature = crypto
        .createHmac('sha1', secret)
        .update(dataToSign)
        .digest('base64url'); // Use base64url for shorter, URL-safe signatures
    return signature;
}

/**
 * Service for attachment operations
 */
class AttachmentService {
    constructor(options) {
        this.db = options.db;
        this.redis = options.redis;
        this.logger = options.logger;
        this.config = options.config;
        this.storageHandler = options.storageHandler; // For potential future use
    }

    /**
     * Get attachment data
     */
    async getAttachment(userId, messageId, attachmentId, returnType = 'base64') {
        // Verify the message exists
        const message = await this.db.database.collection('messages').findOne({
            _id: new ObjectId(messageId)
        }, {
            projection: {
                _id: 1,
                mailbox: 1,
                mimeTree: 1,
                attachments: 1
            }
        });

        if (!message) {
            throw new Error('Message not found');
        }

        // If userId provided, verify user owns this message
        if (userId) {
            const mailbox = await this.db.database.collection('mailboxes').findOne({
                _id: message.mailbox,
                user: new ObjectId(userId)
            });

            if (!mailbox) {
                throw new Error('Message not found');
            }
        }

        // Get the GridFS ID from the attachment map
        let gridfsId;
        if (message.mimeTree?.attachmentMap && message.mimeTree.attachmentMap[attachmentId]) {
            // Use the mapped GridFS ID
            gridfsId = message.mimeTree.attachmentMap[attachmentId];
        } else {
            // Fallback: try to use attachmentId directly as GridFS ID
            gridfsId = attachmentId;
        }

        // Get the attachment from GridFS
        const attachment = await this.db.gridfs.collection('attachments.files').findOne({
            _id: gridfsId
        });

        if (!attachment) {
            throw new Error('Attachment not found');
        }

        if (returnType === 'info') {
            return {
                id: attachment._id.toString(),
                filename: attachment.filename,
                contentType: attachment.contentType,
                size: attachment.length,
                disposition: attachment.metadata?.disposition || 'attachment'
            };
        }

        // Get attachment data from GridFS
        const chunks = await this.db.gridfs.collection('attachments.chunks')
            .find({ files_id: attachment._id })
            .sort({ n: 1 })
            .toArray();

        const buffer = Buffer.concat(chunks.map(chunk => chunk.data.buffer));

        if (returnType === 'base64') {
            return {
                data: buffer.toString('base64'),
                contentType: attachment.contentType,
                filename: attachment.filename,
                size: attachment.length
            };
        } else if (returnType === 'buffer') {
            return {
                data: buffer,
                contentType: attachment.contentType,
                filename: attachment.filename,
                size: attachment.length
            };
        }

        throw new Error('Invalid return type');
    }

    /**
     * Generate secure attachment URL
     */
    generateSecureAttachmentUrl(messageId, attachmentId, filename, baseUrl) {
        const secret = this.config?.attachmentSecret || 'default-secret';
        const expires = Math.floor(Date.now() / 1000) + 3600; // 1 hour expiry

        const signature = signData([messageId, attachmentId, expires], secret);

        return `${baseUrl}/plugin/mcp/att/${messageId}/${attachmentId}/${expires}/${signature}/${encodeURIComponent(filename)}`;
    }

    /**
     * Verify secure attachment URL
     */
    verifySecureAttachmentUrl(messageId, attachmentId, expires, signature) {
        const secret = this.config?.attachmentSecret || 'default-secret';
        const now = Math.floor(Date.now() / 1000);

        // Check if expired
        if (now > parseInt(expires, 10)) {
            throw new Error('Attachment link expired');
        }

        // Verify signature
        const expectedSignature = signData([messageId, attachmentId, expires], secret);

        if (signature !== expectedSignature) {
            throw new Error('Invalid attachment signature');
        }

        return true;
    }
}

module.exports = AttachmentService;