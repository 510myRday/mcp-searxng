#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { NodeHtmlMarkdown } from "node-html-markdown";

// Use a static version string that will be updated by the version script
const packageVersion = "0.4.6";

const WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description:
    "Performs a web search using the SearXNG API, ideal for general queries, news, articles, and online content. " +
    "Use this for broad information gathering, recent events, or when you need diverse web sources.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query. This is the main input for the web search",
      },
      pageno: {
        type: "number",
        description: "Search page number (starts at 1)",
        default: 1,
      },
      time_range: {
        type: "string",
        description: "Time range of search (day, month, year)",
        enum: ["day", "month", "year"],
        default: "",
      },
      language: {
        type: "string",
        description:
          "Language code for search results (e.g., 'en', 'fr', 'de'). Default is instance-dependent.",
        default: "all",
      },
      safesearch: {
        type: "string",
        description:
          "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: ["0", "1", "2"],
        default: "0",
      },
    },
    required: ["query"],
  },
};

const READ_URL_TOOL: Tool = {
  name: "web_url_read",
  description:
    "Read the content from an URL. " +
    "Use this for further information retrieving to understand the content of each URL.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL",
      },
    },
    required: ["url"],
  },
};

// Server implementation
const server = new Server(
  {
    name: "ihor-sokoliuk/mcp-searxng",
    version: packageVersion,
  },
  {
    capabilities: {
      resources: {},
      tools: {
        searxng_web_search: {
          description: WEB_SEARCH_TOOL.description,
          schema: WEB_SEARCH_TOOL.inputSchema,
        },
        web_url_read: {
          description: READ_URL_TOOL.description,
          schema: READ_URL_TOOL.inputSchema,
        },
      },
    },
  }
);

interface SearXNGWeb {
  results: Array<{
    title: string;
    content: string;
    url: string;
    score?: number;
  }>;
}

function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  time_range?: string;
  language?: string;
  safesearch?: string;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string"
  );
}

// 工具函数：删除文本中的所有链接
function removeLinksFromText(text: string): string {
  return text
    // 删除 Markdown 链接 [文本](url)
    .replace(/\[([^\]]*)\]\([^\)]+\)/g, '$1')
    // 删除 http/https 链接
    .replace(/https?:\/\/[^\s]+/g, '')
    // 删除 www. 开头的链接
    .replace(/www\.[^\s]+/g, '')
    // 删除引用标记如[1], [2]等
    .replace(/\[\d+\]/g, '')
    // 合并多余空格
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function performWebSearch(
  query: string,
  pageno: number = 1,
  time_range?: string,
  language: string = "all",
  safesearch?: string
) {
  const searxngUrl = process.env.SEARXNG_URL || "http://localhost:8080";
  const url = new URL(`${searxngUrl}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", pageno.toString());

  if (
    time_range !== undefined &&
    ["day", "month", "year"].includes(time_range)
  ) {
    url.searchParams.set("time_range", time_range);
  }

  if (language && language !== "all") {
    url.searchParams.set("language", language);
  }

  if (safesearch !== undefined && ["0", "1", "2"].includes(safesearch)) {
    url.searchParams.set("safesearch", safesearch);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(
      `SearXNG API error: ${response.status} ${
        response.statusText
      }\n${await response.text()}`
    );
  }

  const data = (await response.json()) as SearXNGWeb;

  // 使用 Promise.all 并行处理所有结果
  const results = await Promise.all((data.results || []).map(async (result) => {
    const score = result.score || 0;
    // let fullText = ""; // 暂时屏蔽

    // 当 score >= 1 时，获取完整内容（暂时屏蔽）
    /*
    if (score >= 1 && result.url) {
      try {
        fullText = await fetchAndConvertToMarkdown(result.url);
      } catch (error) {
        console.error(`Failed to fetch content for ${result.url}:`, error);
      }
    }
    */

    return {
      title: removeLinksFromText(result.title || ""),
      content: removeLinksFromText(result.content || ""),
      url: (result.url && result.url.includes("video")) ? "" : (result.url || ""),
      score: score,
      // text: fullText  // 新增字段，存储完整内容（暂时屏蔽）
    };
  }));

  return results
    .map((r) => {
      let output = `Title: ${r.title}\nDescription: ${r.content}\nScore: ${r.score}\nURL: ${r.url}`;
      /* 暂时屏蔽显示完整内容
      if (r.text) {
        output += `\nText: ${r.text}`;
      }
      */
      return output;
    })
    .join("\n\n");
}

async function fetchAndConvertToMarkdown(
  url: string,
  timeoutMs: number = 10000
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch the URL: ${response.statusText}`);
    }

    const htmlContent = await response.text();
    let markdownContent = NodeHtmlMarkdown.translate(htmlContent);

    // 清理和格式化内容
    markdownContent = removeLinksFromText(markdownContent);

    return markdownContent;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [WEB_SEARCH_TOOL, READ_URL_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    if (name === "searxng_web_search") {
      if (!isSearXNGWebSearchArgs(args)) {
        throw new Error("Invalid arguments for searxng_web_search");
      }
      const {
        query,
        pageno = 1,
        time_range,
        language = "all",
        safesearch,
      } = args;
      const results = await performWebSearch(
        query,
        pageno,
        time_range,
        language,
        safesearch
      );
      return {
        content: [{ type: "text", text: '（以下为纯文本内容，不包含图片）' + results }],
        isError: false,
      };
    }

    if (name === "web_url_read") {
      const { url } = args;
      const result = await fetchAndConvertToMarkdown(url as string);
      return {
        content: [{ type: "text", text: '（以下为纯文本内容，不包含图片）' + result }],
        isError: false,
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
