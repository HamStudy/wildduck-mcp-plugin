'use strict';

const HttpHandler = require('./handlers/http-handler');

/**
 * Main MCP Server class that coordinates handlers
 */
class MCPServer {
    constructor(options) {
        this.logger = options.logger;
        
        // Store handlers
        this.userHandler = options.userHandler;
        this.mailboxHandler = options.mailboxHandler;
        this.messageHandler = options.messageHandler;
        this.storageHandler = options.storageHandler;
        
        // Initialize handlers
        this.httpHandler = new HttpHandler(options);
    }

    /**
     * Handle HTTP JSON-RPC requests
     */
    async handleHTTP(req, res, next) {
        return this.httpHandler.handleHTTP(req, res, next);
    }

    /**
     * Handle individual endpoints for backward compatibility
     */
    async handleInitialize(req, res, next) {
        try {
            if (!this.httpHandler.requireAuthentication(req, res, next)) {
                return;
            }

            const result = await this.httpHandler.handleInitialize();
            this.httpHandler.sendResponse(res, null, result, next);
        } catch (err) {
            this.httpHandler.sendError(res, null, err, next);
        }
    }

    async handleListResources(req, res, next) {
        try {
            if (!this.httpHandler.requireAuthentication(req, res, next)) {
                return;
            }

            const result = await this.httpHandler.handleResourcesList();
            this.httpHandler.sendResponse(res, null, result, next);
        } catch (err) {
            this.httpHandler.sendError(res, null, err, next);
        }
    }

    async handleReadResource(req, res, next) {
        try {
            if (!this.httpHandler.requireAuthentication(req, res, next)) {
                return;
            }

            const { uri } = req.params;
            const result = await this.httpHandler.handleResourceRead(req.user, uri, req);
            this.httpHandler.sendResponse(res, null, result, next);
        } catch (err) {
            this.httpHandler.sendError(res, null, err, next);
        }
    }

    async handleListTools(req, res, next) {
        try {
            if (!this.httpHandler.requireAuthentication(req, res, next)) {
                return;
            }

            const result = await this.httpHandler.handleToolsList();
            this.httpHandler.sendResponse(res, null, result, next);
        } catch (err) {
            this.httpHandler.sendError(res, null, err, next);
        }
    }

    async handleCallTool(req, res, next) {
        try {
            if (!this.httpHandler.requireAuthentication(req, res, next)) {
                return;
            }

            const { name } = req.params;
            const { arguments: args } = req.body || {};
            const result = await this.httpHandler.handleToolCall(req.user, name, args || {});
            this.httpHandler.sendResponse(res, null, result, next);
        } catch (err) {
            this.httpHandler.sendError(res, null, err, next);
        }
    }

    async handleListPrompts(req, res, next) {
        try {
            if (!this.httpHandler.requireAuthentication(req, res, next)) {
                return;
            }

            const result = await this.httpHandler.handlePromptsList();
            this.httpHandler.sendResponse(res, null, result, next);
        } catch (err) {
            this.httpHandler.sendError(res, null, err, next);
        }
    }

    async handleGetPrompt(req, res, next) {
        try {
            if (!this.httpHandler.requireAuthentication(req, res, next)) {
                return;
            }

            const { name } = req.params;
            const result = await this.httpHandler.handlePromptGet(name);
            this.httpHandler.sendResponse(res, null, result, next);
        } catch (err) {
            this.httpHandler.sendError(res, null, err, next);
        }
    }

    async handleSecureAttachment(req, res, next) {
        try {
            const { messageId, attachmentId, expires, signature, filename } = req.params;
            
            // Create attachment service instance
            const attachmentService = this.httpHandler.attachmentService;
            
            // Verify the secure URL
            try {
                attachmentService.verifySecureAttachmentUrl(messageId, attachmentId, expires, signature);
            } catch (err) {
                res.status(403);
                res.send('Forbidden: ' + err.message);
                return next();
            }
            
            // Note: For secure attachments, we don't require user authentication
            // The signature itself proves access rights
            
            // Get attachment data
            const attachmentData = await attachmentService.getAttachment(
                null, // No user ID check for secure URLs
                messageId,
                attachmentId,
                'buffer'
            );
            
            // Set headers
            res.setHeader('Content-Type', attachmentData.contentType);
            res.setHeader('Content-Length', attachmentData.size);
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
            
            // Send attachment data
            res.write(attachmentData.data);
            res.end();
            
        } catch (err) {
            this.httpHandler.sendError(res, null, err, next);
        }
    }
}

module.exports = MCPServer;