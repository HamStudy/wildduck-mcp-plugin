'use strict';

const BaseHandler = require('./base-handler');
const MailboxService = require('../services/mailbox-service');
const MessageService = require('../services/message-service');
const UserService = require('../services/user-service');
const AttachmentService = require('../services/attachment-service');

/**
 * HTTP JSON-RPC handler for MCP protocol
 */
class HttpHandler extends BaseHandler {
    constructor(options) {
        super(options);
        
        // Store handlers
        this.userHandler = options.userHandler;
        this.mailboxHandler = options.mailboxHandler;
        this.messageHandler = options.messageHandler;
        this.storageHandler = options.storageHandler;
        
        // Initialize services with handlers
        this.mailboxService = new MailboxService(options);
        this.attachmentService = new AttachmentService(options);
        this.messageService = new MessageService({
            ...options,
            attachmentService: this.attachmentService
        });
        this.userService = new UserService(options);
        
        // MCP protocol version
        this.protocolVersion = '2024-11-05';
    }

    /**
     * Handle HTTP JSON-RPC requests
     */
    async handleHTTP(req, res, next) {
        try {
            // Check authentication (handled by middleware)
            if (!this.requireAuthentication(req, res, next)) {
                return;
            }

            const { method, params, id } = req.body || {};

            this.logger.info('MCP', 'HTTP JSON-RPC request', {
                method,
                id,
                user: req.user
            });

            let result;

            // Handle JSON-RPC methods
            switch (method) {
                case 'initialize':
                    result = await this.handleInitialize(params);
                    break;

                case 'notifications/initialized':
                    // Client has completed initialization
                    this.logger.info('MCP', 'Client initialization complete');
                    
                    // Verify we can find the user before proceeding
                    if (req.user) {
                        try {
                            const userInfo = await this.userService.getUserInfo(req.user);
                            this.logger.info('MCP', 'User verified', { 
                                userId: req.user, 
                                username: userInfo.username 
                            });
                        } catch (err) {
                            this.logger.error('MCP', 'Failed to verify user', { 
                                userId: req.user, 
                                error: err.message 
                            });
                        }
                    }
                    
                    result = {}; // Empty response for notifications
                    break;

                case 'resources/list':
                    result = await this.handleResourcesList();
                    break;
                    
                case 'resources/templates/list':
                    result = await this.handleResourceTemplatesList();
                    break;

                case 'resources/read':
                    if (!params || !params.uri) {
                        throw new Error('URI parameter required for resources/read');
                    }
                    result = await this.handleResourceRead(req.user, params.uri, req);
                    break;

                case 'tools/list':
                    result = await this.handleToolsList();
                    break;

                case 'tools/call':
                    if (!params || !params.name) {
                        throw new Error('Tool name required for tools/call');
                    }
                    result = await this.handleToolCall(req.user, params.name, params.arguments || {});
                    break;

                case 'prompts/list':
                    result = await this.handlePromptsList();
                    break;

                case 'prompts/get':
                    if (!params || !params.name) {
                        throw new Error('Prompt name required for prompts/get');
                    }
                    result = await this.handlePromptGet(params.name);
                    break;

                case 'completion/complete':
                    if (!params || !params.ref || !params.argument) {
                        throw new Error('Reference and argument required for completion/complete');
                    }
                    result = await this.handleCompletion(params.ref, params.argument);
                    break;

                default:
                    throw new Error(`Unknown method: ${method}`);
            }

            this.sendResponse(res, id, result, next);

        } catch (err) {
            this.sendError(res, req.body?.id, err, next);
        }
    }

    /**
     * Handle initialize request
     */
    async handleInitialize() {
        return {
            protocolVersion: this.protocolVersion,
            capabilities: {
                resources: {},
                tools: {},
                prompts: {},
                completion: {
                    providers: [
                        {
                            ref: 'wildduck://completion/mailbox',
                            label: 'Mailbox paths'
                        },
                        {
                            ref: 'wildduck://completion/email',
                            label: 'Email addresses'
                        }
                    ]
                }
            },
            serverInfo: {
                name: 'wildduck-mcp-server',
                version: '1.0.0'
            }
        };
    }

    /**
     * Handle resources list request
     */
    async handleResourcesList() {
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

        return { resources };
    }

    /**
     * Handle resource read request
     */
    async handleResourceRead(userId, uri, req) {
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
            // Handle attachment resource
            const [messageId, attachmentId] = uri.replace('wildduck://attachment/', '').split('/');
            const attachmentData = await this.attachmentService.getAttachment(
                userId, 
                messageId, 
                attachmentId, 
                'base64'
            );
            
            // Return as blob resource
            isBlob = true;
            content = attachmentData.data;
            mimeType = attachmentData.contentType || 'application/octet-stream';
        } else {
            switch (uri) {
                case 'wildduck://mailbox/list':
                    content = await this.mailboxService.getMailboxList(userId, true);
                    break;

                case 'wildduck://messages/recent':
                    content = await this.userService.getRecentMessages(userId, req.query?.mailbox);
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
    }

    /**
     * Handle tools list request
     */
    async handleToolsList() {
        // Check if read-only mode is enabled
        const isReadOnly = this.config?.readOnly;
        
        // Debug logging
        this.logger.info('MCP', 'Tools list requested', { 
            readOnly: isReadOnly,
            configExists: !!this.config,
            configKeys: this.config ? Object.keys(this.config) : [],
            fullConfig: this.config 
        });

        // Define read-only tools
        const readOnlyTools = [
            {
                name: 'listMailboxes',
                description: 'List all mailboxes for the authenticated user',
                inputSchema: {
                    type: 'object',
                    properties: {
                        includeCounters: { type: 'boolean', description: 'Include message counts', default: true }
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
    }

    /**
     * Handle tool call request
     */
    async handleToolCall(userId, toolName, args) {
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

            case 'markAsRead':
                const flags = args.read ? ['\\Seen'] : [];
                const action = args.read ? 'add' : 'remove';
                result = await this.messageService.updateMessageFlags(userId, args.messageId, flags, action);
                break;

            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }

        return {
            content: [{
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }]
        };
    }

    /**
     * Handle prompts list request
     */
    async handlePromptsList() {
        const prompts = [
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
        ];

        return { prompts };
    }

    /**
     * Handle prompt get request
     */
    async handlePromptGet(promptName) {
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

        const prompt = prompts[promptName];
        if (!prompt) {
            throw new Error(`Prompt not found: ${promptName}`);
        }

        return prompt;
    }

    /**
     * Handle resource templates list request
     */
    async handleResourceTemplatesList() {
        // Resource templates allow MCP clients to provide UI for creating new resources
        // with pre-filled content. For example, a template could help users create
        // a new mailbox with standard folders, or compose an email with a specific format.
        // We return an empty list for now but could add templates in the future.
        return { 
            resourceTemplates: []
        };
    }

    /**
     * Handle completion request
     */
    async handleCompletion(ref, argument) {
        const results = [];

        if (ref === 'wildduck://completion/mailbox') {
            // Provide mailbox path completions
            if (!argument.userId) {
                return { completion: { values: [] } };
            }

            try {
                const mailboxes = await this.mailboxService.getMailboxList(argument.userId, false);
                const prefix = argument.value || '';
                
                const completions = mailboxes.mailboxes
                    .map(mb => mb.path)
                    .filter(path => path.toLowerCase().startsWith(prefix.toLowerCase()))
                    .slice(0, 10); // Limit to 10 suggestions

                return {
                    completion: {
                        values: completions,
                        hasMore: false
                    }
                };
            } catch (err) {
                return { completion: { values: [] } };
            }
        } else if (ref === 'wildduck://completion/email') {
            // Provide email address completions
            if (!argument.userId) {
                return { completion: { values: [] } };
            }

            try {
                const userInfo = await this.userService.getUserInfo(argument.userId);
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
    }
}

module.exports = HttpHandler;