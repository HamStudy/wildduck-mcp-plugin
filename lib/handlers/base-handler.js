'use strict';

/**
 * Base handler class for MCP operations
 */
class BaseHandler {
    constructor(options) {
        this.db = options.db;
        this.redis = options.redis;
        this.logger = options.logger;
        this.config = options.config;
        
        // Store handlers if provided
        this.userHandler = options.userHandler;
        this.mailboxHandler = options.mailboxHandler;
        this.messageHandler = options.messageHandler;
        this.storageHandler = options.storageHandler;
    }

    /**
     * Check if request is authenticated (user already set by middleware)
     */
    requireAuthentication(req, res, next) {
        if (!req.user) {
            res.status(401).json({ 
                error: 'Authentication required',
                code: 'MISSING_TOKEN',
                message: 'Access token must be provided in URL path or query parameter'
            });
            if (next) next();
            return false;
        }
        return true;
    }

    /**
     * Send JSON-RPC success response
     */
    sendResponse(res, id, result, next) {
        res.json({
            jsonrpc: '2.0',
            id,
            result
        });
        if (next) next();
    }

    /**
     * Send JSON-RPC error response
     */
    sendError(res, id, error, next) {
        this.logger.error('MCP', 'Handler error', error);
        res.json({
            jsonrpc: '2.0',
            id: id || null,
            error: {
                code: -32603,
                message: error.message || error
            }
        });
        if (next) next();
    }
}

module.exports = BaseHandler;