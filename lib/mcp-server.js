'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { 
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    CompleteRequestSchema,
    isInitializeRequest
} = require('@modelcontextprotocol/sdk/types.js');
const crypto = require('crypto');

const MailboxService = require('./services/mailbox-service');
const MessageService = require('./services/message-service');
const UserService = require('./services/user-service');
const AttachmentService = require('./services/attachment-service');

/**
 * MCP Server implementation using the official SDK with StreamableHTTPServerTransport
 */
class MCPServerOfficial {
    constructor(options) {
        this.logger = options.logger;
        this.config = options.config;
        
        // Store WildDuck handlers
        this.userHandler = options.userHandler;
        this.mailboxHandler = options.mailboxHandler;
        this.messageHandler = options.messageHandler;
        this.storageHandler = options.storageHandler;
        
        // Initialize services
        this.mailboxService = new MailboxService(options);
        this.attachmentService = new AttachmentService(options);
        this.messageService = new MessageService({
            ...options,
            attachmentService: this.attachmentService
        });
        this.userService = new UserService(options);
        
        // Track active transports by session ID
        this.transports = new Map();
        
        // Protocol version
        this.protocolVersion = '2024-11-05';
    }
    
    /**
     * Create a new MCP server instance
     */
    createServer() {
        const server = new Server({
            name: 'wildduck-mcp-server',
            version: '1.0.0'
        }, {
            capabilities: this.getServerCapabilities()
        });
        
        // Register all handlers
        this.registerHandlers(server);
        
        return server;
    }
    
    /**
     * Get server capabilities based on configuration
     */
    getServerCapabilities() {
        return {
            resources: {
                subscribe: false,
                listChanged: false
            },
            tools: {
                listChanged: false
            },
            prompts: {
                listChanged: false
            },
            completion: {}
        };
    }
    
    /**
     * Register all MCP handlers
     */
    registerHandlers(server) {
        // Resources handlers
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: [
                {
                    uri: 'wildduck://mailbox/list',
                    name: 'User Mailboxes',
                    description: 'List all mailboxes for a user',
                    mimeType: 'application/json'
                },
                {
                    uri: 'wildduck://messages/recent',
                    name: 'Recent Messages',
                    description: 'Get recent messages from a mailbox',
                    mimeType: 'application/json'
                },
                {
                    uri: 'wildduck://user/info',
                    name: 'User Information',
                    description: 'Get user account information',
                    mimeType: 'application/json'
                }
            ]
        }));
        
        server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
            const { uri } = request.params;
            const userId = extra?.authInfo?.userId;
            
            if (!userId) {
                throw new Error('User authentication required');
            }
            
            let content;
            let mimeType = 'application/json';
            let isBlob = false;
            
            // Handle different resource types
            if (uri.startsWith('wildduck://message/')) {
                const messageId = uri.replace('wildduck://message/', '');
                content = await this.messageService.getMessage(userId, messageId, {
                    includeBody: true,
                    includeAttachments: true
                });
            } else if (uri.startsWith('wildduck://attachment/')) {
                const [messageId, attachmentId] = uri.replace('wildduck://attachment/', '').split('/');
                const attachmentData = await this.attachmentService.getAttachment(
                    userId, 
                    messageId, 
                    attachmentId, 
                    'base64'
                );
                
                isBlob = true;
                content = attachmentData.data;
                mimeType = attachmentData.contentType || 'application/octet-stream';
            } else {
                switch (uri) {
                    case 'wildduck://mailbox/list':
                        content = await this.mailboxService.getMailboxList(userId, true);
                        break;
                        
                    case 'wildduck://messages/recent':
                        content = await this.userService.getRecentMessages(userId);
                        break;
                        
                    case 'wildduck://user/info':
                        content = await this.userService.getUserInfo(userId);
                        break;
                        
                    default:
                        throw new Error(`Unknown resource: ${uri}`);
                }
            }
            
            return {
                contents: [{
                    uri,
                    mimeType,
                    ...(isBlob ? { blob: content } : { text: JSON.stringify(content, null, 2) })
                }]
            };
        });
        
        // Tools handlers
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            const isReadOnly = this.config?.readOnly;
            
            // Define read-only tools
            const readOnlyTools = [
                {
                    name: 'listMailboxes',
                    description: 'List all mailboxes for the authenticated user',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            includeCounters: { 
                                type: 'boolean', 
                                description: 'Include message counts', 
                                default: true 
                            }
                        }
                    }
                },
                {
                    name: 'getMessages',
                    description: 'Get messages from a mailbox',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            mailbox: { type: 'string', description: 'Mailbox ID or path' },
                            limit: { type: 'number', description: 'Maximum messages to return', default: 20 },
                            page: { type: 'number', description: 'Page number for pagination', default: 1 },
                            includeBodies: { type: 'boolean', description: 'Include message bodies', default: false }
                        }
                    }
                },
                {
                    name: 'getMessage',
                    description: 'Get a specific message by ID',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            messageId: { type: 'string', description: 'Message ID' },
                            includeBody: { type: 'boolean', description: 'Include full message body', default: true },
                            includeAttachments: { type: 'boolean', description: 'Include attachment info', default: true }
                        },
                        required: ['messageId']
                    }
                },
                {
                    name: 'searchMessages',
                    description: 'Search messages across mailboxes',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Search query' },
                            mailbox: { type: 'string', description: 'Mailbox ID or path (optional)' },
                            limit: { type: 'number', description: 'Maximum results', default: 10 }
                        },
                        required: ['query']
                    }
                },
                {
                    name: 'getThread',
                    description: 'Get all messages in a conversation thread',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            messageId: { type: 'string', description: 'Message ID to find thread for' },
                            includeBody: { type: 'boolean', description: 'Include message bodies', default: false }
                        },
                        required: ['messageId']
                    }
                },
                {
                    name: 'getAttachment',
                    description: 'Download an attachment from a message',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            messageId: { type: 'string', description: 'Message ID' },
                            attachmentId: { type: 'string', description: 'Attachment ID' },
                            returnType: { 
                                type: 'string', 
                                description: 'How to return the attachment data',
                                enum: ['base64', 'info'],
                                default: 'base64'
                            }
                        },
                        required: ['messageId', 'attachmentId']
                    }
                }
            ];
            
            let tools = [...readOnlyTools];
            
            // Add write tools if not in read-only mode
            if (!isReadOnly) {
                const writeTools = [
                    {
                        name: 'createMailbox',
                        description: 'Create a new mailbox folder',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                path: { type: 'string', description: 'Mailbox path (e.g., "Projects/AI")' }
                            },
                            required: ['path']
                        }
                    },
                    {
                        name: 'moveMessage',
                        description: 'Move a message to another mailbox',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                messageId: { type: 'string', description: 'Message ID' },
                                targetMailbox: { type: 'string', description: 'Target mailbox ID' }
                            },
                            required: ['messageId', 'targetMailbox']
                        }
                    },
                    {
                        name: 'deleteMessage',
                        description: 'Delete a message',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                messageId: { type: 'string', description: 'Message ID' },
                                permanently: { type: 'boolean', description: 'Delete permanently', default: false }
                            },
                            required: ['messageId']
                        }
                    },
                    {
                        name: 'markAsRead',
                        description: 'Mark a message as read or unread',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                messageId: { type: 'string', description: 'Message ID' },
                                read: { type: 'boolean', description: 'Mark as read (true) or unread (false)', default: true }
                            },
                            required: ['messageId']
                        }
                    }
                ];
                
                tools = tools.concat(writeTools);
            }
            
            return { tools };
        });
        
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const { name: toolName, arguments: args } = request.params;
            const userId = extra?.authInfo?.userId;
            
            if (!userId) {
                throw new Error('User authentication required');
            }
            
            let result;
            
            switch (toolName) {
                case 'listMailboxes':
                    result = await this.mailboxService.getMailboxList(userId, args.includeCounters);
                    break;
                    
                case 'getMessages':
                    result = await this.messageService.getMessages(userId, args);
                    break;
                    
                case 'getMessage':
                    result = await this.messageService.getMessage(userId, args.messageId, args);
                    break;
                    
                case 'searchMessages':
                    result = await this.messageService.searchMessages(userId, args);
                    break;
                    
                case 'getThread':
                    result = await this.messageService.getThread(userId, args.messageId, args.includeBody);
                    break;
                    
                case 'getAttachment':
                    result = await this.attachmentService.getAttachment(
                        userId,
                        args.messageId,
                        args.attachmentId,
                        args.returnType || 'base64'
                    );
                    break;
                    
                case 'createMailbox':
                    result = await this.mailboxService.createMailbox(userId, args.path);
                    break;
                    
                case 'moveMessage':
                    result = await this.messageService.moveMessage(userId, args.messageId, args.targetMailbox);
                    break;
                    
                case 'deleteMessage':
                    result = await this.messageService.deleteMessage(userId, args.messageId, args.permanently);
                    break;
                    
                case 'markAsRead': {
                    const flags = args.read ? ['\\Seen'] : [];
                    const action = args.read ? 'add' : 'remove';
                    result = await this.messageService.updateMessageFlags(userId, args.messageId, flags, action);
                    break;
                }
                    
                default:
                    throw new Error(`Unknown tool: ${toolName}`);
            }
            
            return {
                content: [{
                    type: 'text',
                    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                }]
            };
        });
        
        // Prompts handlers
        server.setRequestHandler(ListPromptsRequestSchema, async () => ({
            prompts: [
                {
                    name: 'summarize_email',
                    description: 'Summarize an email message',
                    arguments: [
                        {
                            name: 'messageId',
                            description: 'Message ID to summarize',
                            required: true
                        }
                    ]
                },
                {
                    name: 'draft_reply',
                    description: 'Draft a reply to an email',
                    arguments: [
                        {
                            name: 'messageId',
                            description: 'Message ID to reply to',
                            required: true
                        },
                        {
                            name: 'tone',
                            description: 'Tone of the reply (formal, casual, etc.)',
                            required: false
                        }
                    ]
                }
            ]
        }));
        
        server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            const { name } = request.params;
            
            const prompts = {
                summarize_email: {
                    name: 'summarize_email',
                    description: 'Summarize an email message',
                    arguments: [
                        {
                            name: 'messageId',
                            description: 'Message ID to summarize',
                            required: true
                        }
                    ]
                },
                draft_reply: {
                    name: 'draft_reply',
                    description: 'Draft a reply to an email',
                    arguments: [
                        {
                            name: 'messageId',
                            description: 'Message ID to reply to',
                            required: true
                        },
                        {
                            name: 'tone',
                            description: 'Tone of the reply (formal, casual, etc.)',
                            required: false
                        }
                    ]
                }
            };
            
            const prompt = prompts[name];
            if (!prompt) {
                throw new Error(`Prompt not found: ${name}`);
            }
            
            return prompt;
        });
        
        // Completion handler
        server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
            const { ref, argument } = request.params;
            const userId = extra?.authInfo?.userId;
            
            if (!userId) {
                return { completion: { values: [] } };
            }
            
            if (ref.uri === 'wildduck://completion/mailbox') {
                try {
                    const mailboxes = await this.mailboxService.getMailboxList(userId, false);
                    const prefix = argument.value || '';
                    
                    const completions = mailboxes.mailboxes
                        .map(mb => mb.path)
                        .filter(path => path.toLowerCase().startsWith(prefix.toLowerCase()))
                        .slice(0, 10);
                    
                    return {
                        completion: {
                            values: completions,
                            hasMore: false
                        }
                    };
                } catch (err) {
                    return { completion: { values: [] } };
                }
            } else if (ref.uri === 'wildduck://completion/email') {
                try {
                    const userInfo = await this.userService.getUserInfo(userId);
                    const prefix = argument.value || '';
                    
                    const completions = userInfo.addresses
                        .map(addr => addr.address)
                        .filter(email => email.toLowerCase().startsWith(prefix.toLowerCase()))
                        .slice(0, 10);
                    
                    return {
                        completion: {
                            values: completions,
                            hasMore: false
                        }
                    };
                } catch (err) {
                    return { completion: { values: [] } };
                }
            }
            
            return { completion: { values: [] } };
        });
    }
    
    /**
     * Handle any MCP request - let the transport figure out what to do
     */
    async handleRequest(req, res) {
        try {
            // Check authentication
            if (!req.user) {
                res.status(401);
                res.json({ 
                    error: 'Authentication required',
                    code: 'MISSING_TOKEN',
                    message: 'Access token must be provided'
                });
                return;
            }
            
            // Add auth info to request
            req.auth = { userId: req.user };
            
            // Get or create transport based on session
            const sessionId = req.headers['mcp-session-id'] || req.headers['x-session-id'];
            let transport = this.transports.get(sessionId);
            
            // For POST requests without session, check if it's initialization
            if (!transport && req.method === 'POST' && isInitializeRequest(req.body)) {
                // Create new transport for initialization
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => crypto.randomUUID(),
                    onsessioninitialized: (sid) => {
                        this.logger.info('MCP', 'Session initialized sessionId=%s', sid);
                        this.transports.set(sid, transport);
                    }
                });
                
                // Set up cleanup
                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid && this.transports.has(sid)) {
                        this.logger.info('MCP', 'Transport closed sessionId=%s', sid);
                        this.transports.delete(sid);
                    }
                };
                
                // Connect to server
                const server = this.createServer();
                await server.connect(transport);
            }
            
            if (!transport) {
                // No transport and not an initialization request
                res.status(400);
                res.json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'No session found. Initialize first.'
                    },
                    id: req.body?.id || null
                });
                return;
            }
            
            // Let the transport handle the request
            await transport.handleRequest(req, res, req.body);
            
        } catch (err) {
            this.logger.error('MCP', 'Request handler error error=%s', err.message);
            if (!res.headersSent) {
                res.status(500);
                res.json({
                    jsonrpc: '2.0',
                    id: req.body?.id || null,
                    error: {
                        code: -32603,
                        message: err.message
                    }
                });
            }
        }
    }
    
    /**
     * Handle secure attachment download
     */
    async handleSecureAttachment(req, res) {
        try {
            const { messageId, attachmentId, expires, signature, filename } = req.params;
            
            // Verify the secure URL
            try {
                this.attachmentService.verifySecureAttachmentUrl(messageId, attachmentId, expires, signature);
            } catch (err) {
                res.status(403);
                res.send('Forbidden: ' + err.message);
                return;
            }
            
            // Get attachment data
            const attachmentData = await this.attachmentService.getAttachment(
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
            this.logger.error('MCP', 'Secure attachment error error=%s', err.message);
            res.status(500);
            res.json({ error: err.message });
        }
    }
    
    /**
     * Cleanup on server shutdown
     */
    async shutdown() {
        this.logger.info('MCP', 'Shutting down MCP server');
        
        // Close all active transports
        for (const [sessionId, transport] of this.transports) {
            try {
                this.logger.verbose('MCP', 'Closing transport sessionId=%s', sessionId);
                await transport.close();
            } catch (err) {
                this.logger.error('MCP', 'Error closing transport sessionId=%s error=%s', sessionId, err.message);
            }
        }
        
        this.transports.clear();
    }
}

module.exports = MCPServerOfficial;