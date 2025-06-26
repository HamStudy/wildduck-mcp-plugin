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
} = require('@modelcontextprotocol/sdk/types.js');

const MailboxService = require('./services/mailbox-service');
const MessageService = require('./services/message-service');
const UserService = require('./services/user-service');
const AttachmentService = require('./services/attachment-service');

/**
 * Get base URL from request headers, handling proxy headers
 */
function getBaseUrl(req, config) {
    if (req) {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        // Use x-forwarded-host if available (from proxy), otherwise use host
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        return `${proto}://${host}`;
    } else if (config?.apiUrl) {
        // Use configured API URL if available
        return config.apiUrl;
    } else {
        return 'http://localhost:8080';
    }
}

/**
 * MCP Server implementation using the official SDK with StreamableHTTPServerTransport
 */
class MCPServerOfficial {
    constructor(options) {
        this.logger = options.logger;
        this.config = options.config;
        
        this.logger.info('MCP-INIT', 'Initializing MCP Server with config=%j', {
            readOnly: this.config?.readOnly,
            apiUrl: this.config?.apiUrl
        });
        
        // Store WildDuck handlers
        this.userHandler = options.userHandler;
        this.mailboxHandler = options.mailboxHandler;
        this.messageHandler = options.messageHandler;
        this.storageHandler = options.storageHandler;
        
        this.logger.verbose('MCP-INIT', 'WildDuck handlers attached successfully');
        
        // Initialize services
        this.mailboxService = new MailboxService(options);
        this.attachmentService = new AttachmentService(options);
        this.messageService = new MessageService({
            ...options,
            attachmentService: this.attachmentService
        });
        this.userService = new UserService(options);
        
        this.logger.verbose('MCP-INIT', 'Services initialized successfully');
        
        // Protocol version
        this.protocolVersion = '2024-11-05';
        
        this.logger.info('MCP-INIT', 'MCP Server initialization complete, protocol=%s', this.protocolVersion);
    }
    
    /**
     * Create a new MCP server instance
     */
    createServer() {
        this.logger.info('MCP-SERVER', 'Creating new MCP server instance');
        
        const capabilities = this.getServerCapabilities();
        this.logger.verbose('MCP-SERVER', 'Server capabilities=%j', capabilities);
        
        const serverInfo = {
            name: 'wildduck-mcp-server',
            version: '1.0.0'
        };
        
        this.logger.verbose('MCP-SERVER', 'Creating server with info=%j', serverInfo);
        
        const server = new Server(serverInfo, {
            capabilities
        });
        
        this.logger.verbose('MCP-SERVER', 'Server created, registering handlers');
        
        // Register all handlers
        this.registerHandlers(server);
        
        this.logger.info('MCP-SERVER', 'MCP server instance created successfully');
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
            }
        };
    }
    
    /**
     * Register all MCP handlers
     */
    registerHandlers(server, userId, req) {
        this.logger.info('MCP-HANDLER', 'Starting handler registration for user=%s', userId);
        
        // Resources handlers
        this.logger.info('MCP-HANDLER', 'Registering ListResources handler');
        server.setRequestHandler(ListResourcesRequestSchema, async () => {
            this.logger.info('MCP-RESOURCES', 'ListResources request received');
            const resources = [
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
            ];
            this.logger.verbose('MCP-RESOURCES', 'Returning %d resources', resources.length);
            return { resources };
        });
        this.logger.info('MCP-HANDLER', 'ListResources handler registered successfully');
        
        server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            this.logger.verbose('MCP-HANDLER', 'ReadResource request received uri=%s', request.params.uri);
            const { uri } = request.params;
            
            let content;
            let mimeType = 'application/json';
            let isBlob = false;
            
            // Handle different resource types
            if (uri.startsWith('wildduck://message/')) {
                const messageId = uri.replace('wildduck://message/', '');
                content = await this.messageService.getMessage(userId, messageId, {
                    includeBody: true,
                    includeAttachments: true,
                    _req: req // Pass request for URL generation
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
        this.logger.info('MCP-HANDLER', 'Registering ListTools handler');
        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
            this.logger.info('MCP-TOOLS', 'ListTools request received');
            this.logger.verbose('MCP-TOOLS', 'Request details=%j', request);
            
            const isReadOnly = this.config?.readOnly;
            this.logger.verbose('MCP-TOOLS', 'Configuration readOnly=%s', isReadOnly);
            
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
                    description: 'Search messages with advanced filters. IMPORTANT: To find emails from/to a specific address, use the "from" or "to" parameters, NOT the "query" parameter. Examples: {"from": "r@zzt.net"} finds emails FROM that address. {"to": "kd7bbc@hamstudy.org"} finds emails TO that address. The "query" parameter searches message content only.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            // Text search
                            query: { 
                                type: 'string', 
                                description: 'Full-text search in message CONTENT (body text). Do NOT use this for email addresses - use "from" or "to" instead' 
                            },
                            
                            // Specific field searches
                            from: { 
                                type: 'string', 
                                description: 'Find emails FROM this sender (email address or name). Example: "john@example.com" or "John"' 
                            },
                            to: { 
                                type: 'string', 
                                description: 'Find emails TO this recipient (searches To: and Cc: fields). Example: "jane@example.com"' 
                            },
                            subject: { 
                                type: 'string', 
                                description: 'Search in subject line. Example: "invoice" or "meeting"' 
                            },
                            
                            // Location filters
                            mailbox: { type: 'string', description: 'Mailbox ID or path to search in' },
                            thread: { type: 'string', description: 'Thread ID to get all messages in thread' },
                            
                            // Date filters
                            dateStart: { type: 'string', description: 'Start date (ISO format or date string)' },
                            dateEnd: { type: 'string', description: 'End date (ISO format or date string)' },
                            
                            // Size filters
                            minSize: { type: 'number', description: 'Minimum message size in bytes' },
                            maxSize: { type: 'number', description: 'Maximum message size in bytes' },
                            
                            // Flag filters
                            flagged: { type: 'boolean', description: 'Only flagged messages' },
                            unseen: { type: 'boolean', description: 'Only unread messages' },
                            attachments: { type: 'boolean', description: 'Only messages with attachments' },
                            searchable: { type: 'boolean', description: 'Exclude Junk and Trash folders', default: true },
                            
                            // Results control
                            limit: { type: 'number', description: 'Maximum results to return', default: 20 },
                            page: { type: 'number', description: 'Page number for pagination', default: 1 },
                            threadCounters: { type: 'boolean', description: 'Include thread message counts', default: false }
                        }
                    }
                },
                {
                    name: 'searchMessagesOr',
                    description: 'Search with OR conditions - finds emails matching ANY of the specified criteria. Perfect for finding all correspondence with someone (use both from and to in the or object).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            or: {
                                type: 'object',
                                description: 'OR conditions - message matches if ANY of these are true. Example: {"from": "john@example.com", "to": "john@example.com"} finds all emails from OR to John',
                                properties: {
                                    query: { type: 'string', description: 'Full-text search in message content (NOT for email addresses)' },
                                    from: { type: 'string', description: 'Sender email/name' },
                                    to: { type: 'string', description: 'Recipient email/name (To/Cc)' },
                                    subject: { type: 'string', description: 'Subject line text' }
                                }
                            },
                            // Can combine with AND filters
                            dateStart: { type: 'string', description: 'Start date filter' },
                            dateEnd: { type: 'string', description: 'End date filter' },
                            mailbox: { type: 'string', description: 'Mailbox to search in' },
                            attachments: { type: 'boolean', description: 'Has attachments' },
                            limit: { type: 'number', description: 'Maximum results', default: 20 },
                            page: { type: 'number', description: 'Page number', default: 1 }
                        },
                        required: ['or']
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
                    name: 'getMultipleMessages',
                    description: 'Get multiple messages by their IDs in a single call',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            messageIds: { 
                                type: 'array', 
                                items: { type: 'string' },
                                description: 'Array of message IDs to fetch'
                            },
                            includeBody: { type: 'boolean', description: 'Include full message bodies', default: true },
                            includeAttachments: { type: 'boolean', description: 'Include attachment info', default: true }
                        },
                        required: ['messageIds']
                    }
                },
                {
                    name: 'getAttachment',
                    description: 'Get attachment URL or download attachment data',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            messageId: { type: 'string', description: 'Message ID' },
                            attachmentId: { type: 'string', description: 'Attachment ID' },
                            returnType: { 
                                type: 'string', 
                                description: 'How to return the attachment - url (secure download URL), base64 (base64 encoded data), or info (metadata only)',
                                enum: ['url', 'base64', 'info'],
                                default: 'url'
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
                this.logger.verbose('MCP-TOOLS', 'Added write tools, total count=%d', tools.length);
            }
            
            this.logger.info('MCP-TOOLS', 'Returning %d tools (readOnly=%s)', tools.length, isReadOnly);
            this.logger.verbose('MCP-TOOLS', 'Tool names=%j', tools.map(t => t.name));
            
            const response = { tools };
            this.logger.verbose('MCP-TOOLS', 'Full response=%j', response);
            
            return response;
        });
        this.logger.info('MCP-HANDLER', 'ListTools handler registered successfully');
        
        this.logger.info('MCP-HANDLER', 'Registering CallTool handler');
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name: toolName, arguments: args } = request.params;
            this.logger.info('MCP-TOOLS', 'CallTool request received tool=%s args=%j', toolName, args);
            
            this.logger.verbose('MCP-TOOLS', 'Executing tool=%s for userId=%s', toolName, userId);
            let result;
            
            switch (toolName) {
                case 'listMailboxes':
                    result = await this.mailboxService.getMailboxList(userId, args.includeCounters);
                    break;
                    
                case 'getMessages': {
                    // Include attachments by default when including bodies
                    const getMessagesArgs = {
                        ...args,
                        includeAttachments: args.includeBodies !== false,
                        _req: req // Pass request for URL generation
                    };
                    result = await this.messageService.getMessages(userId, getMessagesArgs);
                    break;
                }
                    
                case 'getMessage': {
                    // Include attachments by default when including body
                    const getMessageArgs = {
                        ...args,
                        includeAttachments: args.includeBody !== false ? true : (args.includeAttachments ?? true),
                        _req: req // Pass request for URL generation
                    };
                    result = await this.messageService.getMessage(userId, args.messageId, getMessageArgs);
                    break;
                }
                    
                case 'searchMessages':
                    result = await this.messageService.searchMessages(userId, { ...args, _req: req });
                    break;
                    
                case 'searchMessagesOr':
                    result = await this.messageService.searchMessagesOr(userId, { ...args, _req: req });
                    break;
                    
                case 'getThread':
                    result = await this.messageService.getThread(userId, args.messageId, args.includeBody, { _req: req });
                    break;
                    
                case 'getMultipleMessages': {
                    const getMultipleArgs = {
                        includeBody: args.includeBody !== false,
                        includeAttachments: args.includeAttachments !== false,
                        _req: req // Pass request for URL generation
                    };
                    result = await this.messageService.getMultipleMessages(userId, args.messageIds, getMultipleArgs);
                    break;
                }
                    
                case 'getAttachment': {
                    const returnType = args.returnType || 'url';
                    
                    if (returnType === 'url') {
                        // Generate secure URL instead of downloading the attachment
                        const baseUrl = getBaseUrl(req, this.config);
                        
                        // Get attachment info to get the filename
                        const attachmentInfo = await this.attachmentService.getAttachment(
                            userId,
                            args.messageId,
                            args.attachmentId,
                            'info'
                        );
                        
                        const secureUrl = this.attachmentService.generateSecureAttachmentUrl(
                            args.messageId,
                            args.attachmentId,
                            attachmentInfo.filename || 'attachment',
                            baseUrl
                        );
                        
                        result = {
                            secureUrl,
                            filename: attachmentInfo.filename,
                            contentType: attachmentInfo.contentType,
                            size: attachmentInfo.size
                        };
                    } else {
                        // Get actual attachment data (base64 or info)
                        result = await this.attachmentService.getAttachment(
                            userId,
                            args.messageId,
                            args.attachmentId,
                            returnType
                        );
                    }
                    break;
                }
                    
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
                    this.logger.error('MCP-TOOLS', 'Unknown tool requested: %s', toolName);
                    throw new Error(`Unknown tool: ${toolName}`);
            }
            
            this.logger.verbose('MCP-TOOLS', 'Tool execution complete tool=%s success=true', toolName);
            
            const response = {
                content: [{
                    type: 'text',
                    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                }]
            };
            
            this.logger.verbose('MCP-TOOLS', 'Tool response tool=%s responseLength=%d', toolName, response.content[0].text.length);
            
            return response;
        });
        this.logger.info('MCP-HANDLER', 'CallTool handler registered successfully');
        
        // Prompts handlers
        server.setRequestHandler(ListPromptsRequestSchema, async () => ({
            prompts: [
                {
                    name: 'find_emails_from',
                    description: 'Find all emails from a specific sender',
                    arguments: [
                        {
                            name: 'sender',
                            description: 'Email address or name to search for',
                            required: true
                        },
                        {
                            name: 'limit',
                            description: 'Maximum number of results (default: 20)',
                            required: false
                        }
                    ]
                },
                {
                    name: 'find_emails_with',
                    description: 'Find emails containing specific keywords or attachments',
                    arguments: [
                        {
                            name: 'query',
                            description: 'Search query (keywords to find in email body/subject)',
                            required: false
                        },
                        {
                            name: 'hasAttachments',
                            description: 'Only find emails with attachments (true/false)',
                            required: false
                        },
                        {
                            name: 'dateRange',
                            description: 'Date range (e.g., "last week", "this month")',
                            required: false
                        }
                    ]
                },
                {
                    name: 'find_attachments',
                    description: 'Find all emails with attachments of a specific type',
                    arguments: [
                        {
                            name: 'fileType',
                            description: 'File type to search for (pdf, doc, xls, image, etc.)',
                            required: false
                        },
                        {
                            name: 'sender',
                            description: 'Filter by sender email address',
                            required: false
                        }
                    ]
                },
                {
                    name: 'read_email_thread',
                    description: 'Read an entire email conversation thread',
                    arguments: [
                        {
                            name: 'messageId',
                            description: 'Any message ID from the thread',
                            required: true
                        }
                    ]
                },
                {
                    name: 'find_correspondence',
                    description: 'Find all emails to or from a specific person',
                    arguments: [
                        {
                            name: 'email',
                            description: 'Email address to find correspondence with',
                            required: true
                        },
                        {
                            name: 'includeCC',
                            description: 'Include emails where person was CCed (default: true)',
                            required: false
                        }
                    ]
                }
            ]
        }));
        
        server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            const { name, arguments: promptArgs } = request.params;
            
            // Generate messages based on the prompt
            let messages = [];
            
            switch (name) {
                case 'find_emails_from': {
                    const sender = promptArgs?.sender;
                    if (!sender) {
                        throw new Error('Sender parameter is required');
                    }
                    messages = [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Find all emails from ${sender}`
                            }
                        },
                        {
                            role: 'assistant', 
                            content: {
                                type: 'text',
                                text: `I'll search for all emails from ${sender}. Let me use the search tool to find them.`
                            }
                        }
                    ];
                    break;
                }
                
                case 'find_emails_with': {
                    const { query, hasAttachments, dateRange } = promptArgs || {};
                    let searchDesc = [];
                    if (query) searchDesc.push(`containing "${query}"`);
                    if (hasAttachments) searchDesc.push('with attachments');
                    if (dateRange) searchDesc.push(`from ${dateRange}`);
                    
                    const description = searchDesc.length > 0 ? searchDesc.join(', ') : 'matching your criteria';
                    
                    messages = [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Find emails ${description}`
                            }
                        },
                        {
                            role: 'assistant',
                            content: {
                                type: 'text', 
                                text: `I'll search for emails ${description}. Let me run the search now.`
                            }
                        }
                    ];
                    break;
                }
                
                case 'find_attachments': {
                    const { fileType, sender } = promptArgs || {};
                    let criteria = [];
                    if (fileType) criteria.push(`${fileType} files`);
                    if (sender) criteria.push(`from ${sender}`);
                    
                    const searchCriteria = criteria.length > 0 ? ` with ${criteria.join(' ')}` : '';
                    
                    messages = [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Find all emails with attachments${searchCriteria}`
                            }
                        },
                        {
                            role: 'assistant',
                            content: {
                                type: 'text',
                                text: `I'll search for emails with attachments${searchCriteria}. Let me find those for you.`
                            }
                        }
                    ];
                    break;
                }
                
                case 'read_email_thread': {
                    const messageId = promptArgs?.messageId;
                    if (!messageId) {
                        throw new Error('Message ID parameter is required');
                    }
                    
                    messages = [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Show me the complete email thread for message ${messageId}`
                            }
                        },
                        {
                            role: 'assistant',
                            content: {
                                type: 'text',
                                text: `I'll retrieve the complete email thread for that message.`
                            }
                        }
                    ];
                    break;
                }
                
                case 'find_correspondence': {
                    const email = promptArgs?.email;
                    if (!email) {
                        throw new Error('Email parameter is required');
                    }
                    
                    messages = [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Find all emails to or from ${email}`
                            }
                        },
                        {
                            role: 'assistant',
                            content: {
                                type: 'text',
                                text: `I'll search for all correspondence with ${email}, including emails where they were the sender, recipient, or CCed.`
                            }
                        }
                    ];
                    break;
                }
                
                default:
                    throw new Error(`Unknown prompt: ${name}`);
            }
            
            return {
                description: `Email search prompt: ${name}`,
                messages
            };
        });
        
        // Completion handler
        server.setRequestHandler(CompleteRequestSchema, async (request) => {
            const { ref, argument } = request.params;
            
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
        
        this.logger.info('MCP-HANDLER', 'All MCP handlers registered successfully');
    }
    
    /**
     * Handle any MCP request - let the transport figure out what to do
     */
    async handleRequest(req, res/*, next*/) {
        this.logger.info('MCP-REQUEST', 'Incoming request method=%s url=%s', req.method, req.url);
        this.logger.verbose('MCP-REQUEST', 'Headers=%j', req.headers);
        this.logger.verbose('MCP-REQUEST', 'Body=%j', req.body);
        
        try {
            // Check authentication
            if (!req.user) {
                this.logger.error('MCP-REQUEST', 'No user authentication found in request');
                
                // Send error response in SSE format
                if (!res.headersSent) {
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache, no-transform');
                    res.setHeader('Connection', 'keep-alive');
                    res.status(200);
                }
                
                const errorResponse = {
                    jsonrpc: '2.0',
                    id: req.body?.id ?? 1, // Use 1 as default if no ID provided
                    error: {
                        code: -32600,
                        message: 'Authentication required',
                        data: {
                            error: 'MISSING_TOKEN',
                            message: 'Access token must be provided'
                        }
                    }
                };
                
                res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
                res.end();
                return;
            }
            
            this.logger.verbose('MCP-REQUEST', 'Authenticated user=%s', req.user);
            
            // Add auth info to request
            req.auth = { userId: req.user };
            
            // Create a new server for this request with auth info
            const server = new Server({
                name: 'wildduck-mcp-server',
                version: '1.0.0'
            }, {
                capabilities: this.getServerCapabilities()
            });
            
            // Register handlers with auth info and request passed through
            this.registerHandlers(server, req.user, req);
            
            // Use StreamableHTTPServerTransport for stateless HTTP
            const transport = new StreamableHTTPServerTransport({ 
                sessionIdGenerator: undefined // Stateless operation
            });
            
            // Clean up on close
            res.on('close', () => {
                transport.close();
                server.close();
            });
            
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            
        } catch (err) {
            this.logger.error('MCP-REQUEST', 'Request handler error error=%s stack=%s', err.message, err.stack);
            this.logger.verbose('MCP-REQUEST', 'Error details=%j', {
                message: err.message,
                code: err.code,
                statusCode: err.statusCode
            });
            
            // Use SSE format for error responses
            if (!res.headersSent) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                res.status(200);
                
                const errorResponse = {
                    jsonrpc: '2.0',
                    id: req.body?.id ?? 1, // Use 1 as default if no ID provided
                    error: {
                        code: -32603,
                        message: err.message
                    }
                };
                
                res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
                res.end();
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
        // Nothing to clean up since we create transports per request
    }
}

module.exports = MCPServerOfficial;
module.exports.getBaseUrl = getBaseUrl;