const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "X-Final-Url",
  "Cross-Origin-Resource-Policy": "cross-origin"
};

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

function toProxyUrl(rawUrl, baseUrl, origin) {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:") || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) {
    return null;
  }
  if (trimmed.startsWith(origin + "/p/")) return trimmed;
  try {
    const abs = new URL(trimmed, baseUrl);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return null;
    const proto = abs.protocol.slice(0, -1);
    return `${origin}/p/${proto}/${abs.host}${abs.pathname}${abs.search}`;
  } catch {
    return null;
  }
}

function rewriteCssUrls(cssText, cssBaseUrl, origin) {
  // Rewrite @import "..."
  let out = cssText.replace(/@import\s+(?:url\(\s*)?(['"]?)([^'"\)\s]+)\1(?:\s*\))?/gi, (match, quote, rel) => {
    const proxied = toProxyUrl(rel, cssBaseUrl, origin);
    return proxied ? `@import url("${proxied}")` : match;
  });
  // Rewrite url(...)
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, rel) => {
    const proxied = toProxyUrl(rel, cssBaseUrl, origin);
    return proxied ? `url("${proxied}")` : match;
  });
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Endpoint /proxy?url=... atau /api/page?url=...
    if (url.pathname === "/proxy" || url.pathname === "/api/page") {
      const targetParam = url.searchParams.get("url");
      if (!targetParam) {
        return new Response("Parameter ?url= wajib diisi", { status: 400, headers: CORS_HEADERS });
      }

      let targetUrl;
      try {
        targetUrl = new URL(/^https?:\/\//i.test(targetParam) ? targetParam : `https://${targetParam}`);
      } catch {
        return new Response("Format URL tidak valid", { status: 400, headers: CORS_HEADERS });
      }

      if (isBlockedHost(targetUrl.hostname)) {
        return new Response("Host tidak diizinkan", { status: 403, headers: CORS_HEADERS });
      }

      try {
        const res = await fetch(targetUrl.href, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7"
          },
          redirect: "follow"
        });

        const finalUrl = new URL(res.url || targetUrl.href);
        const origin = url.origin;

        const helperCss = `
          <style id="daw-reveal-helper">
            *, *::before, *::after {
              animation-delay: 0s !important;
              animation-duration: 0s !important;
              transition-duration: 0s !important;
              transition-delay: 0s !important;
            }
            [data-aos], .aos-init, [data-sr], .reveal, .opacity-0, .invisible {
              opacity: 1 !important;
              visibility: visible !important;
              transform: none !important;
            }
          </style>
        `;

        const rewriter = new HTMLRewriter()
          .on("head", {
            element(el) {
              el.prepend(`<base href="${finalUrl.href}">${helperCss}`, { html: true });
            }
          })
          .on("link", {
            element(el) {
              const rel = (el.getAttribute("rel") || "").toLowerCase();
              const href = el.getAttribute("href");
              if (href) {
                const proxied = toProxyUrl(href, finalUrl.href, origin);
                if (proxied && (rel.includes("stylesheet") || rel.includes("icon") || rel.includes("preload") || rel.includes("font"))) {
                  el.setAttribute("href", proxied);
                  el.setAttribute("crossorigin", "anonymous");
                  el.removeAttribute("integrity");
                }
              }
            }
          })
          .on("style", {
            text(chunk) {
              if (chunk.text) {
                chunk.replace(rewriteCssUrls(chunk.text, finalUrl.href, origin));
              }
            }
          })
          .on("img", {
            element(el) {
              const lazySrc = el.getAttribute("data-src") || el.getAttribute("data-lazy-src") || el.getAttribute("data-original");
              const rawSrc = el.getAttribute("src") || lazySrc;
              if (rawSrc && (!rawSrc.startsWith("data:") || !lazySrc)) {
                const chosen = (rawSrc.startsWith("data:") && lazySrc) ? lazySrc : rawSrc;
                const proxied = toProxyUrl(chosen, finalUrl.href, origin);
                if (proxied) {
                  el.setAttribute("src", proxied);
                }
              }
              el.setAttribute("crossorigin", "anonymous");
              el.setAttribute("loading", "eager");
              el.removeAttribute("srcset");
              el.removeAttribute("data-srcset");
            }
          })
          .on("source", {
            element(el) {
              const srcset = el.getAttribute("srcset");
              if (srcset) {
                const firstUrl = srcset.split(",")[0]?.trim().split(/\s+/)[0];
                const proxied = toProxyUrl(firstUrl, finalUrl.href, origin);
                if (proxied) el.setAttribute("srcset", proxied);
              }
            }
          })
          .on("video", {
            element(el) {
              const poster = el.getAttribute("poster");
              if (poster) {
                const proxied = toProxyUrl(poster, finalUrl.href, origin);
                if (proxied) el.setAttribute("poster", proxied);
              }
            }
          })
          .on("[style]", {
            element(el) {
              const st = el.getAttribute("style");
              if (st && st.includes("url(")) {
                el.setAttribute("style", rewriteCssUrls(st, finalUrl.href, origin));
              }
            }
          })
          .on("script, noscript", {
            element(el) {
              el.remove();
            }
          });

        const transformed = rewriter.transform(res);
        const headers = new Headers(CORS_HEADERS);
        headers.set("Content-Type", "text/html; charset=utf-8");
        headers.set("X-Final-Url", finalUrl.href);

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

    // 3. Endpoint /p/:proto/:host/:path* (Proxy CSS, Font, Gambar, SVG dengan rewrite URL CSS)
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
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
            "Referer": `${proto}://${host}/`,
            "Accept": "*/*"
          },
          cf: { cacheTtl: 3600, cacheEverything: true }
        });

        const contentType = assetRes.headers.get("content-type") || "";
        const headers = new Headers(CORS_HEADERS);
        if (contentType) headers.set("Content-Type", contentType);
        headers.set("Cache-Control", "public, max-age=3600");

        // Jika file adalah CSS, tulis ulang semua url(...) di dalamnya agar font & background-image juga lewat proxy
        if (contentType.includes("text/css") || path.endsWith(".css")) {
          const cssText = await assetRes.text();
          const rewrittenCss = rewriteCssUrls(cssText, assetUrl, url.origin);
          headers.set("Content-Type", "text/css; charset=utf-8");
          return new Response(rewrittenCss, {
            status: assetRes.status,
            headers
          });
        }

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
