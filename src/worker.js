const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

// Keamanan dasar: cegah akses ke IP lokal/internal (SSRF protection)
function isBlockedHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local")
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Tangani CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Endpoint /proxy?url=https://... (Untuk mengambil HTML halaman target)
    if (url.pathname === "/proxy") {
      const targetParam = url.searchParams.get("url");
      if (!targetParam) {
        return new Response("Parameter ?url= wajib diisi", { status: 400, headers: CORS_HEADERS });
      }

      let targetUrl;
      try {
        targetUrl = new URL(targetParam.startsWith("http") ? targetParam : `https://${targetParam}`);
      } catch {
        return new Response("Format URL tidak valid", { status: 400, headers: CORS_HEADERS });
      }

      if (isBlockedHost(targetUrl.hostname)) {
        return new Response("Host tidak diizinkan", { status: 403, headers: CORS_HEADERS });
      }

      try {
        const res = await fetch(targetUrl.href, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          },
          redirect: "follow"
        });

        const finalUrl = new URL(res.url || targetUrl.href);
        const origin = url.origin;

        // Gunakan HTMLRewriter bawaan Cloudflare untuk menyisipkan <base>
        // dan mengarahkan <img src> ke rute proxy /p/... agar aman di <canvas>
        const rewriter = new HTMLRewriter()
          .on("head", {
            element(el) {
              el.prepend(`<base href="${finalUrl.href}">`, { html: true });
            }
          })
          .on("img", {
            element(el) {
              const src = el.getAttribute("src");
              if (src && !src.startsWith("data:") && !src.startsWith("blob:")) {
                try {
                  const abs = new URL(src, finalUrl.href);
                  const proto = abs.protocol.slice(0, -1); // 'http' atau 'https'
                  el.setAttribute("src", `${origin}/p/${proto}/${abs.host}${abs.pathname}${abs.search}`);
                  el.setAttribute("crossorigin", "anonymous");
                } catch {}
              }
              // Hapus srcset agar browser menggunakan src yang sudah diproxy
              el.removeAttribute("srcset");
            }
          })
          // Matikan script dari website target agar tidak mengganggu jalannya game
          .on("script", {
            element(el) {
              el.remove();
            }
          });

        const transformed = rewriter.transform(res);
        const headers = new Headers(CORS_HEADERS);
        headers.set("Content-Type", "text/html; charset=utf-8");

        return new Response(transformed.body, {
          status: res.status,
          headers
        });
      } catch (err) {
        return new Response(`Gagal mengambil halaman: ${err.message}`, {
          status: 502,
          headers: CORS_HEADERS
        });
      }
    }

    // 3. Endpoint /p/:proto/:host/:path* (Proxy gambar & aset seperti fungsi Q4 asli)
    if (url.pathname.startsWith("/p/")) {
      const match = url.pathname.match(/^\/p\/(https?)\/([^/]+)(\/.*)?$/);
      if (!match) {
        return new Response("Format path proxy tidak valid", { status: 400, headers: CORS_HEADERS });
      }

      const [, proto, host, path = "/"] = match;
      if (isBlockedHost(host)) {
        return new Response("Host tidak diizinkan", { status: 403, headers: CORS_HEADERS });
      }

      const assetUrl = `${proto}://${host}${path}${url.search}`;
      try {
        const assetRes = await fetch(assetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0",
            "Referer": `${proto}://${host}/`
          },
          cf: { cacheTtl: 3600, cacheEverything: true }
        });

        const headers = new Headers(CORS_HEADERS);
        const contentType = assetRes.headers.get("content-type");
        if (contentType) headers.set("Content-Type", contentType);
        headers.set("Cache-Control", "public, max-age=3600");

        return new Response(assetRes.body, {
          status: assetRes.status,
          headers
        });
      } catch {
        return new Response("Gagal memuat aset", { status: 502, headers: CORS_HEADERS });
      }
    }

    // 4. Sajikan file statis (public/index.html)
    return env.ASSETS.fetch(request);
  }
};