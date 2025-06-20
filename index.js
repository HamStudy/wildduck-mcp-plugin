'use strict';

const MCPServer = require('./lib/mcp-server');

module.exports.title = 'WildDuck MCP Server';

module.exports.init = (app, done) => {
    const logger = app.logger;
    const config = app.config || {};
    
    logger.info('MCP', 'Initializing WildDuck MCP Server plugin');
    
    // Debug: Log what's available in app
    logger.info('MCP', 'Available app properties:', Object.keys(app));
    logger.info('MCP', 'Available db properties:', app.db ? Object.keys(app.db) : 'No db object');
    logger.info('MCP', 'Available handlers:', {
        userHandler: !!app.userHandler,
        mailboxHandler: !!app.mailboxHandler,
        messageHandler: !!app.messageHandler,
        storageHandler: !!app.storageHandler
    });
    
    // Initialize MCP server with WildDuck context
    const mcpServer = new MCPServer({
        db: app.db,
        redis: app.redis,
        logger: logger,
        config: config,
        // Handlers from WildDuck
        userHandler: app.userHandler,
        mailboxHandler: app.mailboxHandler,
        messageHandler: app.messageHandler,
        storageHandler: app.storageHandler
    });
    
    // Register MCP protocol endpoints
    // These will be available at /plugin/mcp/*
    // All endpoints support token in URL: /plugin/mcp/:accessToken/...
    
    // MCP initialization endpoint
    app.addAPI('POST', '/initialize', (req, res, next) => {
        mcpServer.handleInitialize(req, res, next);
    });
    app.addAPI('POST', '/:accessToken/initialize', (req, res, next) => {
        mcpServer.handleInitialize(req, res, next);
    });
    
    // MCP resources listing
    app.addAPI('GET', '/resources', (req, res, next) => {
        mcpServer.handleListResources(req, res, next);
    });
    app.addAPI('GET', '/:accessToken/resources', (req, res, next) => {
        mcpServer.handleListResources(req, res, next);
    });
    
    // MCP resource reading
    app.addAPI('GET', '/resources/:uri', (req, res, next) => {
        mcpServer.handleReadResource(req, res, next);
    });
    app.addAPI('GET', '/:accessToken/resources/:uri', (req, res, next) => {
        mcpServer.handleReadResource(req, res, next);
    });
    
    // MCP tools listing
    app.addAPI('GET', '/tools', (req, res, next) => {
        mcpServer.handleListTools(req, res, next);
    });
    app.addAPI('GET', '/:accessToken/tools', (req, res, next) => {
        mcpServer.handleListTools(req, res, next);
    });
    
    // MCP tool execution
    app.addAPI('POST', '/tools/:name', (req, res, next) => {
        mcpServer.handleCallTool(req, res, next);
    });
    app.addAPI('POST', '/:accessToken/tools/:name', (req, res, next) => {
        mcpServer.handleCallTool(req, res, next);
    });
    
    // MCP prompts listing
    app.addAPI('GET', '/prompts', (req, res, next) => {
        mcpServer.handleListPrompts(req, res, next);
    });
    app.addAPI('GET', '/:accessToken/prompts', (req, res, next) => {
        mcpServer.handleListPrompts(req, res, next);
    });
    
    // MCP prompt retrieval
    app.addAPI('GET', '/prompts/:name', (req, res, next) => {
        mcpServer.handleGetPrompt(req, res, next);
    });
    app.addAPI('GET', '/:accessToken/prompts/:name', (req, res, next) => {
        mcpServer.handleGetPrompt(req, res, next);
    });
    
    // Secure attachment download (no authentication required - uses signed URLs)
    // Format: /plugin/mcp/att/<msgid>/<attid>/<expires>/<signature>/filename.ext
    app.addAPI('GET', '/att/:messageId/:attachmentId/:expires/:signature/:filename', (req, res, next) => {
        mcpServer.handleSecureAttachment(req, res, next);
    });
    
    // HTTP transport endpoint (root endpoint for JSON-RPC)
    app.addAPI('POST', '/:accessToken', (req, res, next) => {
        mcpServer.handleHTTP(req, res, next);
    });
    
    // Also support without token in path (using query param or headers)
    app.addAPI('POST', '/', (req, res, next) => {
        mcpServer.handleHTTP(req, res, next);
    });
    
    // Server information
    app.addAPI('GET', '/info', (req, res, next) => {
        res.json({
            name: 'wildduck-mcp-server',
            version: '1.0.0',
            protocolVersion: '2024-11-05',
            capabilities: {
                resources: true,
                tools: true,
                prompts: true
            }
        });
        next();
    });
    app.addAPI('GET', '/:accessToken/info', (req, res, next) => {
        res.json({
            name: 'wildduck-mcp-server',
            version: '1.0.0',
            protocolVersion: '2024-11-05',
            capabilities: {
                resources: true,
                tools: true,
                prompts: true
            }
        });
        next();
    });
    
    // Initialize hook - called when all services are ready
    app.addHook('init', async () => {
        logger.info('MCP', 'WildDuck MCP Server ready at /plugin/mcp');
    });
    
    setImmediate(done);
};