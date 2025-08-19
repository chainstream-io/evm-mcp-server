import startServer from "./server.js";
import express, { Request, Response } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Environment variables
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const HOST = process.env.HOST || '0.0.0.0';

console.error(`Configured to listen on ${HOST}:${PORT}`);

// Setup Express
const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  exposedHeaders: ['Content-Type', 'Access-Control-Allow-Origin']
}));

// Add OPTIONS handling for preflight requests
app.options('*', cors());

// Initialize the server
let server: McpServer | null = null;
startServer().then(s => {
  server = s;
  console.error("MCP Server initialized successfully");
}).catch(error => {
  console.error("Failed to initialize server:", error);
  process.exit(1);
});

// Helper function to serialize objects with BigInt values
function serializeWithBigInt(obj: any): string {
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }, 2);
}

// Helper function to handle tool calls
async function handleToolCall(server: McpServer, toolName: string, args: any): Promise<string> {
  try {
    // Import the actual EVM services
    const services = await import("../core/services/index.js");
    
    // Handle different tools
    switch (toolName) {
      case "get_balance": {
        const address = args.address;
        const network = args.network || "ethereum";
        try {
          const balance = await services.getETHBalance(address, network);
          return serializeWithBigInt({
            address,
            network,
            wei: balance.wei,
            ether: balance.ether
          });
        } catch (error) {
          return `Error fetching balance: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
        
      case "get_chain_info": {
        const chainNetwork = args.network || "ethereum";
        try {
          const chainId = await services.getChainId(chainNetwork);
          const blockNumber = await services.getBlockNumber(chainNetwork);
          const { getRpcUrl } = await import("../core/chains.js");
          const rpcUrl = getRpcUrl(chainNetwork);
          
          return serializeWithBigInt({
            network: chainNetwork,
            chainId,
            blockNumber,
            rpcUrl
          });
        } catch (error) {
          return `Error fetching chain info: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
        
      case "get_supported_networks": {
        try {
          const { getSupportedNetworks } = await import("../core/chains.js");
          const networks = getSupportedNetworks();
          return JSON.stringify({
            supportedNetworks: networks
          }, null, 2);
        } catch (error) {
          return `Error fetching supported networks: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
        
      case "get_latest_block": {
        const blockNetwork = args.network || "ethereum";
        try {
          const block = await services.getLatestBlock(blockNetwork);
          return serializeWithBigInt(block);
        } catch (error) {
          return `Error fetching latest block: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
        
      case "resolve_ens": {
        const ensName = args.ensName;
        const ensNetwork = args.network || "ethereum";
        try {
          const address = await services.resolveAddress(ensName, ensNetwork);
          return JSON.stringify({
            ensName,
            resolvedAddress: address,
            network: ensNetwork
          }, null, 2);
        } catch (error) {
          return `Error resolving ENS name: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
        
      case "transfer_eth": {
        const { privateKey, to, amount, network: transferNetwork = "ethereum" } = args;
        try {
          const txHash = await services.transferETH(privateKey, to, amount, transferNetwork);
          return JSON.stringify({
            success: true,
            txHash,
            to,
            amount,
            network: transferNetwork
          }, null, 2);
        } catch (error) {
          return `Error transferring ETH: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
        
      default:
        return `Tool ${toolName} not implemented yet. Args: ${JSON.stringify(args)}`;
    }
  } catch (error) {
    console.error(`Error in handleToolCall:`, error);
    return `Error executing tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Define routes - Standard MCP HTTP Streamable endpoint
app.post("/mcp", async (req: Request, res: Response) => {
  console.error(`Received MCP request from ${req.ip}`);
  console.error(`Request body: ${JSON.stringify(req.body)}`);
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (!server) {
    console.error("Server not initialized yet");
    return res.status(503).json({ error: "Server not initialized" });
  }
  
  try {
    // Handle MCP request manually
    const { method, params, id } = req.body;
    
    let response;
    switch (method) {
      case "initialize":
        response = {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: "EVM-Server",
              version: "1.0.0"
            }
          }
        };
        break;
        
      case "tools/list":
        // Return available tools
        response = {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "get_balance",
                description: "Get the native token balance (ETH, MATIC, etc.) for an address",
                inputSchema: {
                  type: "object",
                  properties: {
                    address: { 
                      type: "string",
                      description: "The wallet address or ENS name (e.g., '0x1234...' or 'vitalik.eth')"
                    },
                    network: { 
                      type: "string",
                      description: "Network name (e.g., 'ethereum', 'optimism', 'arbitrum', 'base', etc.)"
                    }
                  },
                  required: ["address"]
                }
              },
              {
                name: "get_chain_info",
                description: "Get information about an EVM network",
                inputSchema: {
                  type: "object",
                  properties: {
                    network: { 
                      type: "string",
                      description: "Network name (e.g., 'ethereum', 'optimism', 'arbitrum', 'base', etc.)"
                    }
                  }
                }
              },
              {
                name: "get_supported_networks",
                description: "Get a list of supported EVM networks",
                inputSchema: {
                  type: "object",
                  properties: {}
                }
              },
              {
                name: "get_latest_block",
                description: "Get the latest block from the EVM",
                inputSchema: {
                  type: "object",
                  properties: {
                    network: { 
                      type: "string",
                      description: "Network name (e.g., 'ethereum', 'optimism', 'arbitrum', 'base', etc.)"
                    }
                  }
                }
              },
              {
                name: "resolve_ens",
                description: "Resolve an ENS name to an Ethereum address",
                inputSchema: {
                  type: "object",
                  properties: {
                    ensName: { 
                      type: "string",
                      description: "ENS name to resolve (e.g., 'vitalik.eth')"
                    },
                    network: { 
                      type: "string",
                      description: "Network name (e.g., 'ethereum', 'optimism', 'arbitrum', 'base', etc.)"
                    }
                  },
                  required: ["ensName"]
                }
              },
              {
                name: "transfer_eth",
                description: "Transfer native tokens (ETH, MATIC, etc.) to an address",
                inputSchema: {
                  type: "object",
                  properties: {
                    privateKey: { 
                      type: "string",
                      description: "Private key of the sender account in hex format"
                    },
                    to: { 
                      type: "string",
                      description: "The recipient address or ENS name"
                    },
                    amount: { 
                      type: "string",
                      description: "Amount to send in ETH (e.g., '0.1')"
                    },
                    network: { 
                      type: "string",
                      description: "Network name (e.g., 'ethereum', 'optimism', 'arbitrum', 'base', etc.)"
                    }
                  },
                  required: ["privateKey", "to", "amount"]
                }
              }
            ]
          }
        };
        break;
        
      case "notifications/initialized":
        // Handle initialization notification
        response = {
          jsonrpc: "2.0",
          id: null,
          result: null
        };
        break;
        
      case "tools/call": {
        // Handle tool calls
        const { name, arguments: args } = params;
        
        try {
          if (server) {
            const toolResult = await handleToolCall(server, name, args);
            
            response = {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: toolResult
                  }
                ]
              }
            };
          } else {
            throw new Error("Server not initialized");
          }
        } catch (error) {
          console.error(`Error calling tool ${name}:`, error);
          response = {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
            }
          };
        }
        break;
      }
        
      default:
        response = {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
    }
    
    console.error(`MCP response: ${JSON.stringify(response)}`);
    res.json(response);
  } catch (error) {
    console.error(`Error handling MCP request: ${error}`);
    res.status(500).json({ 
      jsonrpc: "2.0",
      id: req.body.id,
      error: {
        code: -32603,
        message: `Internal server error: ${error}`
      }
    });
  }
});

// Add a simple health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ 
    status: "ok",
    server: server ? "initialized" : "initializing"
  });
});

// Add a root endpoint for basic info
app.get("/", (req: Request, res: Response) => {
  res.status(200).json({
    name: "MCP Server",
    version: "1.0.0",
    endpoints: {
      mcp: "/mcp",
      health: "/health"
    },
    status: server ? "ready" : "initializing"
  });
});

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.error('Shutting down server...');
  process.exit(0);
});

// Start the HTTP server
const httpServer = app.listen(PORT, HOST, () => {
  console.error(`🚀 MCP Server running at http://${HOST}:${PORT}`);
  console.error(`📡 MCP endpoint: http://${HOST}:${PORT}/mcp`);
  console.error(`🏥 Health check: http://${HOST}:${PORT}/health`);
  console.error(`📋 Root info: http://${HOST}:${PORT}/`);
}).on('error', (err: Error) => {
  console.error(`❌ Server error: ${err}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.error('🛑 Received SIGTERM, shutting down gracefully...');
  httpServer.close(() => {
    console.error('✅ Server closed');
    process.exit(0);
  });
}); 