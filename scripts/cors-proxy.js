import fs from "fs"
import http from "http"
import https from "https"
import path from "path"
import { URL } from "url"

const PORT = process.env.PORT || 8081
const ACCOUNTS_FILE = path.join(process.cwd(), "accounts.json")
const MASTER_KEY = process.env.FREEAPI_MASTER_KEY || "204586"

// Read accounts from local JSON file
let accounts = []
function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"))
      console.log(`Loaded ${accounts.length} accounts from accounts.json`)
    }
  } catch (e) {
    console.error("Failed to load accounts.json:", e)
  }
}
loadAccounts()

// In-memory cache for self-learning model support: accountId -> Set of modelNames
const unsupportedModelsCache = new Map()

// Choose candidate accounts sorted by quota descending
function selectCandidateAccounts(modelName) {
  const activeAccounts = accounts.filter((acc) => {
    if (acc.disabled) return false
    if (!acc.site_url || !acc.account_info || !acc.account_info.access_token)
      return false

    // Skip if we know this account doesn't support this model
    if (modelName) {
      const unsupported = unsupportedModelsCache.get(acc.id)
      if (unsupported && unsupported.has(modelName)) {
        return false
      }
    }
    return true
  })

  // Sort by quota descending
  activeAccounts.sort(
    (a, b) => (b.account_info.quota || 0) - (a.account_info.quota || 0),
  )
  return activeAccounts
}

// Forward request to candidate accounts with failover retry
function forwardToAccount(
  candidateAccounts,
  index,
  req,
  res,
  reqBodyBuffer,
  modelName,
) {
  if (index >= candidateAccounts.length) {
    res.writeHead(502, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        error: {
          message: `All available accounts failed or do not support model: ${modelName || "unknown"}`,
          type: "api_error",
        },
      }),
    )
    return
  }

  const account = candidateAccounts[index]
  const parsedUrl = new URL(account.site_url)
  const targetPath = req.url // e.g. /v1/chat/completions

  // Prepare compatibility headers (fanned out user-id headers)
  const userId = account.account_info?.id
  const compatHeaders = {}
  if (userId) {
    const val = String(userId)
    compatHeaders["New-API-User"] = val
    compatHeaders["Veloera-User"] = val
    compatHeaders["X-Api-User"] = val
    compatHeaders["voapi-user"] = val
    compatHeaders["User-id"] = val
    compatHeaders["Rix-Api-User"] = val
    compatHeaders["neo-api-user"] = val
  }

  // Handle Authorization header and endpoint configuration
  let authHeader = `Bearer ${account.account_info.access_token}`
  let targetHost = parsedUrl.hostname
  let targetPort =
    parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80)
  let targetPathPrefix = parsedUrl.pathname.replace(/\/$/, "")

  if (account.site_type === "aihubmix") {
    authHeader = account.account_info.access_token // raw without Bearer prefix
    targetHost = "aihubmix.com"
    targetPort = 443
    targetPathPrefix = ""
  }

  const clientOptions = {
    method: req.method,
    headers: {
      ...req.headers,
      ...compatHeaders,
      authorization: authHeader,
      host: targetHost,
    },
    host: targetHost,
    port: targetPort,
    path: targetPathPrefix + targetPath,
  }

  // Clean up proxy headers to avoid conflicts
  delete clientOptions.headers["x-target-url"]
  delete clientOptions.headers["connection"]
  delete clientOptions.headers["accept-encoding"]

  const protocol =
    parsedUrl.protocol === "https:" || account.site_type === "aihubmix"
      ? https
      : http

  console.log(
    `Forwarding to ${account.site_name} (${account.site_url}) for model ${modelName || "unknown"}`,
  )

  const clientReq = protocol.request(clientOptions, (clientRes) => {
    const statusCode = clientRes.statusCode || 200

    // If upstream returns 404, cache this model as unsupported
    if (statusCode === 404 && modelName) {
      if (!unsupportedModelsCache.has(account.id)) {
        unsupportedModelsCache.set(account.id, new Set())
      }
      unsupportedModelsCache.get(account.id).add(modelName)
      console.log(
        `Cached: account ${account.site_name} (${account.id}) does not support model ${modelName}`,
      )
    }

    // Retry on common rate-limiting or authentication/server errors
    const isRetryableError =
      statusCode === 401 ||
      statusCode === 403 ||
      statusCode === 429 ||
      statusCode === 404 ||
      statusCode >= 500
    if (isRetryableError && index + 1 < candidateAccounts.length) {
      console.warn(
        `Account ${account.site_name} returned status ${statusCode}. Retrying with next candidate...`,
      )
      forwardToAccount(
        candidateAccounts,
        index + 1,
        req,
        res,
        reqBodyBuffer,
        modelName,
      )
      return
    }

    // Write back response headers and pipe body
    res.writeHead(statusCode, clientRes.headers)
    clientRes.pipe(res)
  })

  clientReq.on("error", (err) => {
    console.error(`Request to ${account.site_name} failed: ${err.message}`)
    if (index + 1 < candidateAccounts.length) {
      forwardToAccount(
        candidateAccounts,
        index + 1,
        req,
        res,
        reqBodyBuffer,
        modelName,
      )
    } else {
      res.writeHead(502, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          error: { message: `Proxy error: ${err.message}`, type: "api_error" },
        }),
      )
    }
  })

  clientReq.write(reqBodyBuffer)
  clientReq.end()
}

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS, PUT, PATCH, DELETE",
  )
  res.setHeader("Access-Control-Allow-Headers", "*")
  res.setHeader("Access-Control-Expose-Headers", "*")

  if (req.method === "OPTIONS") {
    res.writeHead(200)
    res.end()
    return
  }

  // 1. Sync accounts endpoint
  if (req.url === "/api/sync-accounts") {
    if (req.method !== "POST") {
      res.writeHead(405)
      res.end("Method Not Allowed")
      return
    }

    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body)
        if (Array.isArray(parsed)) {
          fs.writeFileSync(
            ACCOUNTS_FILE,
            JSON.stringify(parsed, null, 2),
            "utf8",
          )
          accounts = parsed
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ success: true, count: accounts.length }))
          console.log(`Synchronized ${accounts.length} accounts.`)
        } else {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({ error: "Invalid accounts format, must be array" }),
          )
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `Invalid JSON: ${e.message}` }))
      }
    })
    return
  }

  // 2. OpenAI models endpoint
  if (req.url === "/v1/models" && req.method === "GET") {
    // Validate Master Key
    const authHeader = req.headers["authorization"] || ""
    const providedKey = authHeader.replace(/^Bearer\s+/i, "").trim()
    if (providedKey !== MASTER_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          error: {
            message: "Unauthorized: Invalid Master API Key",
            type: "invalid_request_error",
          },
        }),
      )
      return
    }

    const activeAccount = accounts.find((acc) => !acc.disabled && acc.site_url)
    if (activeAccount) {
      console.log(`Forwarding /v1/models request to ${activeAccount.site_name}`)
      // Prepare compat headers
      const userId = activeAccount.account_info?.id
      const compatHeaders = {}
      if (userId) {
        const val = String(userId)
        compatHeaders["New-API-User"] = val
        compatHeaders["Veloera-User"] = val
        compatHeaders["X-Api-User"] = val
        compatHeaders["voapi-user"] = val
        compatHeaders["User-id"] = val
        compatHeaders["Rix-Api-User"] = val
        compatHeaders["neo-api-user"] = val
      }

      let authHeader = `Bearer ${activeAccount.account_info.access_token}`
      const parsedUrl = new URL(activeAccount.site_url)
      let targetHost = parsedUrl.hostname
      let targetPort =
        parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80)
      let targetPathPrefix = parsedUrl.pathname.replace(/\/$/, "")

      if (activeAccount.site_type === "aihubmix") {
        authHeader = activeAccount.account_info.access_token
        targetHost = "aihubmix.com"
        targetPort = 443
        targetPathPrefix = ""
      }

      const clientOptions = {
        method: "GET",
        headers: {
          ...req.headers,
          ...compatHeaders,
          authorization: authHeader,
          host: targetHost,
        },
        host: targetHost,
        port: targetPort,
        path: targetPathPrefix + "/v1/models",
      }

      delete clientOptions.headers["x-target-url"]
      delete clientOptions.headers["connection"]

      const protocol =
        parsedUrl.protocol === "https:" ||
        activeAccount.site_type === "aihubmix"
          ? https
          : http

      const clientReq = protocol.request(clientOptions, (clientRes) => {
        res.writeHead(clientRes.statusCode || 200, clientRes.headers)
        clientRes.pipe(res)
      })

      clientReq.on("error", (err) => {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: {
              message: `Proxy error: ${err.message}`,
              type: "api_error",
            },
          }),
        )
      })
      clientReq.end()
    } else {
      // Fallback static list
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "gpt-4o",
              object: "model",
              created: 1677610602,
              owned_by: "openai",
            },
            {
              id: "claude-3-5-sonnet-20241022",
              object: "model",
              created: 1677610602,
              owned_by: "anthropic",
            },
          ],
        }),
      )
    }
    return
  }

  // 3. OpenAI completions or other API requests
  if (req.url.startsWith("/v1/")) {
    // Validate Master Key
    const authHeader = req.headers["authorization"] || ""
    const providedKey = authHeader.replace(/^Bearer\s+/i, "").trim()
    if (providedKey !== MASTER_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          error: {
            message: "Unauthorized: Invalid Master API Key",
            type: "invalid_request_error",
          },
        }),
      )
      return
    }

    let bodyData = []
    req.on("data", (chunk) => {
      bodyData.push(chunk)
    })
    req.on("end", () => {
      const buffer = Buffer.concat(bodyData)
      let modelName = ""
      try {
        const payload = JSON.parse(buffer.toString("utf8"))
        modelName = payload.model
      } catch (_e) {
        // Ignored, proceed without model filtering cache
      }

      const candidateAccounts = selectCandidateAccounts(modelName)
      if (candidateAccounts.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: {
              message: `No active accounts available for model: ${modelName || "unknown"}`,
              type: "invalid_request_error",
            },
          }),
        )
        return
      }

      forwardToAccount(candidateAccounts, 0, req, res, buffer, modelName)
    })
    return
  }

  // 4. Default fallback: original CORS proxy mode
  const targetUrl = req.headers["x-target-url"]
  if (!targetUrl || typeof targetUrl !== "string") {
    res.writeHead(400)
    res.end("Missing or invalid x-target-url header or unsupported API path")
    return
  }

  try {
    const parsedUrl = new URL(targetUrl)
    const clientOptions = {
      method: req.method,
      headers: { ...req.headers },
      host: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
    }

    // Clean up proxy headers to avoid conflicts
    delete clientOptions.headers["host"]
    delete clientOptions.headers["x-target-url"]
    delete clientOptions.headers["connection"]

    const clientReq = (parsedUrl.protocol === "https:" ? https : http).request(
      clientOptions,
      (clientRes) => {
        res.writeHead(clientRes.statusCode || 200, clientRes.headers)
        clientRes.pipe(res)
      },
    )

    clientReq.on("error", (err) => {
      res.writeHead(502)
      res.end(`Proxy error: ${err.message}`)
    })

    req.pipe(clientReq)
  } catch (err) {
    res.writeHead(400)
    res.end(`Invalid target URL: ${err.message}`)
  }
})

server.listen(Number(PORT), "127.0.0.1", () => {
  console.log(`CORS Proxy & Load Balancer running on http://127.0.0.1:${PORT}`)
})
