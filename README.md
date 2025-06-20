# WildDuck MCP Plugin

A Model Context Protocol (MCP) server plugin for [WildDuck Email Server](https://github.com/nodemailer/wildduck) that enables AI assistants to interact with email data through a standardized API.

## Features

- **MCP Resources**: Access mailboxes, messages, and user information
- **MCP Tools**: Send emails, search messages, manage mailboxes
- **MCP Prompts**: Pre-built prompts for email summarization and reply drafting
- **Web-based Transport**: HTTP/REST API implementation (not STDIO)
- **Full WildDuck Integration**: Direct access to WildDuck's handlers and database

## Installation

1. Clone this repository:
```bash
git clone https://github.com/HamStudy/wildduck-mcp-plugin.git
cd wildduck-mcp-plugin
```

2. Install dependencies:
```bash
npm install
```

3. Create a symbolic link in your WildDuck plugins directory:
```bash
# From your WildDuck installation directory
cd plugins
ln -s /path/to/wildduck-mcp-plugin mcp
```

**Important**: The plugin MUST be symlinked as `mcp` (not `wildduck-mcp-plugin`) for the URL routing to work correctly.

4. Create a configuration file in your WildDuck config directory:
```bash
cp /path/to/wildduck-mcp-plugin/mcp.toml.example config/plugins/mcp.toml
```

5. Add the plugin to your WildDuck plugins configuration:
```toml
# config/plugins.toml (or wherever you configure plugins)
[[plugins]]
name = "mcp"
enabled = true
```

6. Restart WildDuck to load the plugin

## Configuration

Edit `config/plugins/mcp.toml` to configure the plugin. Key settings:

- `enabled`: Enable/disable the plugin
- `mcp.readOnly`: Enable read-only mode (disables all write operations)
- `rateLimit`: API rate limiting
- `cors`: CORS settings for web clients

### Read-Only Mode

When `mcp.readOnly = true`, the plugin operates in read-only mode:
- Only reading tools are available (listMailboxes, getMessages, getMessage, searchMessages)
- Write operations are disabled (sendEmail, moveMessage, deleteMessage, markAsRead, etc.)
- Messages are never automatically marked as read
- Attempts to use write tools return a 403 Forbidden error

## API Endpoints

Once installed, the MCP server is available at:
```
http://your-wildduck-server:8080/plugin/mcp/
```

### MCP Endpoints

- `POST /plugin/mcp/initialize` - Initialize MCP session
- `GET /plugin/mcp/resources` - List available resources
- `GET /plugin/mcp/resources/:uri` - Read a resource
- `GET /plugin/mcp/tools` - List available tools  
- `POST /plugin/mcp/tools/:name` - Execute a tool
- `GET /plugin/mcp/prompts` - List available prompts
- `GET /plugin/mcp/prompts/:name` - Get a prompt

### Authentication

The MCP plugin uses WildDuck's native authentication system. All endpoints require authentication using one of:

1. **URL path parameter** (recommended for MCP clients):
```
/plugin/mcp/{accessToken}/resources
```

2. **X-Access-Token header**:
```
X-Access-Token: your-wildduck-access-token
```

3. **Authorization Bearer header**:
```
Authorization: Bearer your-wildduck-access-token
```

4. **Query parameter** (not recommended):
```
?accessToken=your-wildduck-access-token
```

## Obtaining Access Tokens

To get an access token for the MCP plugin, authenticate with WildDuck's API:

```bash
curl -X POST http://localhost:8080/authenticate \
  -H "Content-Type: application/json" \
  -d '{
    "username": "user@example.com",
    "password": "your-password",
    "scope": "master",
    "token": true
  }'
```

This returns a response with a `token` field:
```json
{
  "success": true,
  "id": "507f1f77bcf86cd799439011",
  "username": "user@example.com",
  "token": "a1b2c3d4e5f6..."
}
```

**Token Types Supported:**
- **Access Tokens** (recommended): Generated via `/authenticate` endpoint
- **Application-Specific Passwords**: 16-character app passwords
- **Master Password**: User's main account password (not recommended for apps)

The authenticated user context is automatically passed to all MCP operations - you never need to specify a user ID.

**Security**: The plugin enforces strict access control:
- Users can only access their own mailboxes and messages
- All operations verify ownership before proceeding
- Attempts to access other users' data will result in "access denied" errors
- Disabled or suspended accounts cannot access the MCP API

## Available Resources

### Static Resources
- `wildduck://mailbox/list` - List user's mailboxes
- `wildduck://messages/recent` - Get recent messages from INBOX or specified mailbox
- `wildduck://user/info` - Get user account information

### Dynamic Resources
- `wildduck://message/{messageId}` - Get a specific message by ID with full content
- `wildduck://attachment/{messageId}/{attachmentId}` - Download an attachment as binary data

**Note**: Message and attachment resource URIs are returned in API responses:
- When listing messages, each message includes a `resourceUri` field
- When getting a message, each attachment includes a `resourceUri` field

## Available Tools

### Email Reading (Always Available)
- `listMailboxes` - List all mailboxes with optional message counts
- `getMessages` - Get messages from a mailbox with pagination (does not mark as read)
  - Each message includes `hasThread` field indicating if it's part of a conversation
- `getMessage` - Get a specific message by ID with full content (does not mark as read)
  - Always includes `thread` information with related messages if part of a conversation
  - Lists attachments with metadata (id, filename, contentType, size)
  - Each attachment includes a `publicUrl` for secure, time-limited direct access
- `getThread` - Get all messages in a conversation thread (finds replies and related messages)
- `getAttachment` - Download an attachment from a message (returns base64 encoded data)
- `searchMessages` - Search messages across mailboxes

### Email Management (Disabled in Read-Only Mode)
- `sendEmail` - Send an email message
- `moveMessage` - Move a message to another mailbox
- `deleteMessage` - Delete a message (move to Trash or permanently)
- `createMailbox` - Create a new mailbox folder
- `markAsRead` - Mark a message as read or unread
- `markAsFlag` - Flag or unflag a message

## Available Prompts

- `email_summary` - Generate a summary of recent emails
- `draft_reply` - Draft a reply to a specific email

## Example Usage

### Using URL-based Authentication (Recommended for MCP)

#### Initialize MCP Session
```bash
curl -X POST http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/initialize \
  -H "Content-Type: application/json" \
  -d '{"protocolVersion": "2024-11-05"}'
```

#### List Mailboxes
```bash
curl http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/resources/wildduck://mailbox/list
```

#### Send Email
```bash
curl -X POST http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/tools/sendEmail \
  -H "Content-Type: application/json" \
  -d '{
    "arguments": {
      "to": "recipient@example.com",
      "subject": "Hello from MCP",
      "text": "This email was sent via MCP!"
    }
  }'
```

#### Download Attachment
```bash
# Get attachment info only
curl -X POST http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/tools/getAttachment \
  -H "Content-Type: application/json" \
  -d '{
    "arguments": {
      "messageId": "507f1f77bcf86cd799439011",
      "attachmentId": "ATT00001",
      "returnType": "info"
    }
  }'

# Download attachment data (base64 encoded)
curl -X POST http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/tools/getAttachment \
  -H "Content-Type: application/json" \
  -d '{
    "arguments": {
      "messageId": "507f1f77bcf86cd799439011",
      "attachmentId": "ATT00001"
    }
  }'
```

#### Access Message via Resource URI
```bash
# First, get messages which includes resource URIs
curl http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/tools/getMessages \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"mailbox": "INBOX"}}'

# Response includes resourceUri for each message:
# {
#   "content": [{
#     "type": "text",
#     "text": "{
#       \"messages\": [{
#         \"id\": \"507f1f77bcf86cd799439011\",
#         \"resourceUri\": \"wildduck://message/507f1f77bcf86cd799439011\"
#         ...
#       }]
#     }"
#   }]
# }

# Access the message directly via its resource URI
curl http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/resources/wildduck://message/507f1f77bcf86cd799439011
```

#### Access Attachment via Resource URI
```bash
# First, get a message to see attachment resource URIs
curl http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/resources/wildduck://message/507f1f77bcf86cd799439011

# Response includes resourceUri for each attachment:
# {
#   "contents": [{
#     "text": "{
#       \"attachments\": [{
#         \"id\": \"ATT00001\",
#         \"filename\": \"document.pdf\",
#         \"resourceUri\": \"wildduck://attachment/507f1f77bcf86cd799439011/ATT00001\"
#         ...
#       }]
#     }"
#   }]
# }

# Download the attachment directly via its resource URI
curl http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/resources/wildduck://attachment/507f1f77bcf86cd799439011/ATT00001
```

#### Secure Public Attachment URLs
```bash
# Get a message to see the public attachment URLs
curl -X POST http://localhost:8080/plugin/mcp/YOUR_ACCESS_TOKEN/tools/getMessage \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"messageId": "507f1f77bcf86cd799439011"}}'

# Response includes publicUrl for each attachment:
# {
#   "content": [{
#     "text": "{
#       \"attachments\": [{
#         \"id\": \"ATT00001\",
#         \"filename\": \"report.pdf\",
#         \"publicUrl\": \"http://localhost:8080/plugin/mcp/att/507f1f77bcf86cd799439011/ATT00001/1734567890/AbCdEf123456-_/report.pdf\"
#         ...
#       }]
#     }"
#   }]
# }

# The publicUrl can be accessed directly without any authentication:
curl "http://localhost:8080/plugin/mcp/att/507f1f77bcf86cd799439011/ATT00001/1734567890/AbCdEf123456-_/report.pdf"

# These URLs are perfect for:
# - Sharing attachments via email or chat
# - Embedding in web applications
# - Temporary download links
# - Public access without exposing auth tokens
```

### Using Header-based Authentication

```bash
curl http://localhost:8080/plugin/mcp/resources/wildduck://mailbox/list \
  -H "X-Access-Token: your-access-token"
```

## Development

To extend the plugin:

1. Add new resources in `lib/mcp-server.js` `initializeCapabilities()`
2. Add new tools with proper input schemas
3. Implement the handler methods
4. Update the configuration schema if needed

## Secure Attachment URLs

The plugin generates secure, time-limited URLs for attachments that can be shared without exposing access tokens:

### How it Works
- Each attachment in a message response includes a `publicUrl` field
- URLs are signed with HMAC-SHA1 and include an expiration timestamp
- Default expiration is 1 hour (configurable)
- No authentication token required - the URL itself contains the authorization
- Clean path-based format: `/plugin/mcp/att/<msgid>/<attid>/<expires>/<signature>/filename.ext`

### Example Response
```json
{
  "attachments": [{
    "id": "ATT00001",
    "filename": "document.pdf",
    "contentType": "application/pdf",
    "size": 102400,
    "resourceUri": "wildduck://attachment/507f1f77bcf86cd799439011/ATT00001",
    "publicUrl": "https://mail.example.com/plugin/mcp/att/507f1f77bcf86cd799439011/ATT00001/1734567890/1a2B3c4D5e6F7g8H/document.pdf"
  }]
}
```

### Configuration
```toml
[mcp.api]
# Public URL is optional - by default URLs are generated from request headers
# Only set this if behind a proxy that doesn't forward proper headers
# publicUrl = "https://mail.example.com"

[mcp.mcp]
# IMPORTANT: Use a secure random string in production!
attachmentSecret = "your-secure-random-string-here"
```

### Security Features
- Time-limited access (expires after 1 hour by default)
- Cryptographically signed URLs prevent tampering
- No database lookups required for validation
- Can be safely shared via email, chat, etc.
- Automatic filename sanitization

## Security Considerations

### Access Control
- **User Isolation**: Each user can only access their own data
- **Ownership Verification**: Every operation verifies resource ownership before proceeding
- **No Cross-User Access**: Attempting to access another user's mailbox or messages will fail
- **Account Status**: Disabled or suspended accounts are blocked from API access

### Best Practices
- Always use HTTPS in production to protect access tokens
- Configure CORS origins appropriately to prevent unauthorized access
- Use URL-based authentication for MCP clients (tokens in URL path)
- Implement rate limiting to prevent abuse
- Monitor access logs for suspicious activity
- Rotate access tokens regularly
- Never share access tokens between users

### Token Security
- WildDuck access tokens have configurable TTL (time to live)
- Tokens are validated on every request
- Invalid or expired tokens are rejected
- Token validation includes signature verification

## License

MIT