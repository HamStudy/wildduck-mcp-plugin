'use strict';

const MCPServer = require('./lib/mcp-server');

module.exports.title = 'WildDuck MCP Server';

module.exports.init = (app, done) => {
    const logger = app.logger;
    const config = app.config || {};
    
    logger.info('MCP-PLUGIN', 'Initializing WildDuck MCP Server plugin (Official SDK)');
    logger.verbose('MCP-PLUGIN', 'Plugin config=%j', config);
    logger.verbose('MCP-PLUGIN', 'Available handlers: user=%s mailbox=%s message=%s storage=%s', 
        !!app.userHandler, !!app.mailboxHandler, !!app.messageHandler, !!app.storageHandler);
    
    // Helper to authenticate requests
    const authenticateRequest = async (req) => {
        // Check various token sources
        let accessToken = req.params.accessToken || 
                         req.query.accessToken || 
                         req.headers['x-access-token'] ||
                         (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
                          ? req.headers.authorization.substring(7) : null);
        
        logger.verbose('MCP-AUTH', 'Authenticating request token=%s hasAuth=%s', 
            accessToken ? '***' + accessToken.slice(-6) : 'none', !!req.authenticate);
        
        if (accessToken && req.authenticate) {
            try {
                const authResult = await req.authenticate(accessToken);
                logger.verbose('MCP-AUTH', 'Auth result authenticated=%s user=%s role=%s', 
                    authResult.authenticated, authResult.user, authResult.role);
                if (authResult.authenticated) {
                    req.user = authResult.user;
                    req.role = authResult.role;
                    return true;
                }
            } catch (err) {
                logger.warn('MCP-AUTH', 'Authentication failed error=%s', err.message);
            }
        }
        return false;
    };
    
    // Initialize MCP server with WildDuck context
    const mcpServer = new MCPServer({
        db: app.db,
        redis: app.redis,
        logger,
        config,
        // Handlers from WildDuck
        userHandler: app.userHandler,
        mailboxHandler: app.mailboxHandler,
        messageHandler: app.messageHandler,
        storageHandler: app.storageHandler
    });
    
    // Register MCP protocol endpoints
    // These will be available at /plugin/mcp/*
    // All endpoints support token in URL: /plugin/mcp/:accessToken/...

    // Secure attachment download (no authentication required - uses signed URLs)
    // Format: /plugin/mcp/att/<msgid>/<attid>/<expires>/<signature>/filename.ext
    app.addAPI('GET', '/att/:messageId/:attachmentId/:expires/:signature/:filename', async (req, res) => {
        await mcpServer.handleSecureAttachment(req, res);
    });


    
    // Server information
    app.addAPI('GET', '/info', (req, res, next) => {
        logger.verbose('MCP-PLUGIN', 'Server info request received');
        const info = {
            name: 'wildduck-mcp-server',
            version: '1.0.0',
            protocolVersion: '2024-11-05',
            capabilities: {
                resources: true,
                tools: true,
                prompts: true
            }
        };
        logger.verbose('MCP-PLUGIN', 'Returning server info=%j', info);
        res.json(info);
        next();
    });
    
    // This has to look like it isn't an async function so restify doesn't
    // try to finalize the response after we handle it
    function handleMCPRequest(req, res, next) {
        (async function _handle() {
            try {
                await authenticateRequest(req);
                
                // Don't set content-type here - let the MCP transport handle it
                
                // the MCP transport often tries to call something like res.writeHead(500).end() but
                // restify doesn't allow that, so we wrap it ot make it work
                const oldWriteHead = res.writeHead;
                res.writeHead = (...args) => {
                    logger.verbose('MCP-PLUGIN', 'Overriding res.writeHead with args=%j', args);
                    oldWriteHead.apply(res, args);
                    return res;
                };
                
                // Also wrap setHeader to ensure headers are set properly
                const oldSetHeader = res.setHeader;
                res.setHeader = (name, value) => {
                    logger.verbose('MCP-PLUGIN', 'Setting header %s=%s', name, value);
                    if (oldSetHeader) {
                        oldSetHeader.call(res, name, value);
                    } else if (res.header) {
                        // Restify uses res.header() instead of res.setHeader()
                        res.header(name, value);
                    }
                    return res;
                };
                
                // Ensure getHeader method exists (MCP SDK might need it)
                if (!res.getHeader) {
                    res.getHeader = (name) => {
                        const headers = res.getHeaders ? res.getHeaders() : res.headers || {};
                        return headers[name.toLowerCase()];
                    };
                }

                // The MCP transport needs full control over the response
                await mcpServer.handleRequest(req, res, next);
                
                // DO NOT call next() - the MCP transport owns the response now
                // Calling next() would cause Restify to try to finalize the response
                
            } catch (err) {
                logger.error('MCP-PLUGIN', 'Request handling error: %s', err.message);
                next(err);
            }
        })().catch(next)
    }

    // Forward all MCP requests to the handler
    // Handle all methods (POST, GET, DELETE) with token in path
    ['POST', 'GET', 'DEL'].forEach(method => {
        logger.verbose('MCP-PLUGIN', 'Registering %s routes', method);
        
        app.addAPI(method, '/:accessToken', handleMCPRequest);
        app.addAPI(method, '/:accessToken/*', handleMCPRequest);
        
        // Also support without token in path (using query param or headers)
        app.addAPI(method, '/', handleMCPRequest);
        app.addAPI(method, '*', handleMCPRequest);
    });
    
    logger.info('MCP-PLUGIN', 'All MCP routes registered at /plugin/mcp/*');
    
    // // Initialize hook - called when all services are ready
    // app.addHook('init', async () => {
    //     logger.info('MCP', 'WildDuck MCP Server ready at /plugin/mcp');
    // });
    
    // Shutdown hook - clean up resources
    app.addHook('close', async () => {
        logger.info('MCP', 'Shutting down MCP Server');
        await mcpServer.shutdown();
    });
    
    logger.info('MCP-PLUGIN', 'WildDuck MCP Server plugin initialization complete');
    setImmediate(() => {
        logger.info('MCP-PLUGIN', 'Plugin ready to receive requests at /plugin/mcp/*');
        done();
    });
};