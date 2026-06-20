import http from "http"
import https from "https"
import { URL } from "url"

const PORT = process.env.PORT || 8081

const server = http.createServer((req, res) => {
  // Add CORS headers
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

  const targetUrl = req.headers["x-target-url"]
  if (!targetUrl || typeof targetUrl !== "string") {
    res.writeHead(400)
    res.end("Missing or invalid x-target-url header")
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
        // Forward status and headers
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
  console.log(`CORS Proxy running on http://127.0.0.1:${PORT}`)
})
