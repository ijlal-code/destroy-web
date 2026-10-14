const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cross-Origin-Resource-Policy": "cross-origin"
};

// Keamanan dasar: cegah akses ke IP lokal/internal (SSRF protection)
function isBlockedHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h.startsWith("127.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) ||
    h.endsWith(".internal") ||
    h.endsWith(".local")
  );
}

// Konversi URL relatif/eksternal menjadi rute proxy /p/:proto/:host/:path
function toProxyUrl(rawUrl, baseHref, origin) {
  if (!rawUrl) return rawUrl;
  const trimmed = rawUrl.trim();
  if (
    !trimmed ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith(origin + "/p/") ||
    trimmed.startsWith("/p/")
  ) {
    return rawUrl;
  }
  try {
    const abs = new URL(trimmed, baseHref);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return rawUrl;
    if (isBlockedHost(abs.hostname)) return rawUrl;
    const proto = abs.protocol.slice(0, -1);
    return `${origin}/p/${proto}/${abs.host}${abs.pathname}${abs.search}`;
  } catch {
    return rawUrl;
  }
}

// Tulis ulang semua url(...) dan @import di dalam kode CSS agar melalui proxy
function rewriteCssUrls(cssText, baseHref, origin) {
  if (!cssText) return cssText;
  let out = cssText.replace(
    /@import\s+(?:url\(\s*)?(['"]?)([^'"\)\s]+)\1\s*\)?/gi,
    (match, quote, rawUrl) => {
      const proxied = toProxyUrl(rawUrl, baseHref, origin);
      return `@import url("${proxied}")`;
    }
  );
  out = out.replace(
    /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi,
    (match, quote, rawUrl) => {
      const trimmed = rawUrl.trim();
      if (trimmed.startsWith("data:") || trimmed.startsWith("#")) return match;
      const proxied = toProxyUrl(trimmed, baseHref, origin);
      return `url("${proxied}")`;
    }
  );
  return out;
}

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function fetchAndProxyAsset(proto, host, path, search, origin, request) {
  if (isBlockedHost(host)) {
    return new Response("Host tidak diizinkan", { status: 403, headers: CORS_HEADERS });
  }
  const assetUrl = `${proto}://${host}${path}${search}`;
  try {
    const assetRes = await fetch(assetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": request.headers.get("Accept") || "*/*",
        "Referer": `${proto}://${host}/`
      },
      redirect: "follow",
      cf: { cacheTtl: 3600, cacheEverything: true }
    });

    const headers = new Headers(CORS_HEADERS);
    const contentType = assetRes.headers.get("content-type") || "";
    if (contentType) headers.set("Content-Type", contentType);
    headers.set("Cache-Control", "public, max-age=3600");

    // Jika aset adalah file CSS, tulis ulang semua url(...) dan @import di dalamnya
    if (contentType.toLowerCase().includes("text/css") || path.toLowerCase().endsWith(".css")) {
      const cssText = await assetRes.text();
      const finalAssetUrl = assetRes.url || assetUrl;
      const rewrittenCss = rewriteCssUrls(cssText, finalAssetUrl, origin);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Tangani CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Endpoint /proxy?url=https://... (Mengambil & menulis ulang HTML halaman target)
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
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7"
          },
          redirect: "follow"
        });

        const finalUrl = new URL(res.url || targetUrl.href);
        const origin = url.origin;
        const baseHref = finalUrl.href;
        const targetRoute = (finalUrl.pathname || "/") + (finalUrl.search || "") + (finalUrl.hash || "");

        // Injeksi helper script & style di <head> agar:
        // - Router SPA (React/Vite/Next/Vue) membaca path asli, bukan /proxy
        // - Fetch/XHR/Image dinamis otomatis diarahkan ke proxy /p/...
        // - Animasi scroll-reveal (AOS, Framer Motion, Reveal, dll) langsung tampil penuh
        const headInjection = `
<script>
(function() {
  const ORIGIN = ${JSON.stringify(origin)};
  const FINAL_HREF = ${JSON.stringify(baseHref)};
  const TARGET_ROUTE = ${JSON.stringify(targetRoute)};
  try {
    if (location.pathname === '/proxy' || location.pathname === '/') {
      history.replaceState(null, '', TARGET_ROUTE || '/');
    }
  } catch (e) {}

  function toProxy(u) {
    if (!u || typeof u !== 'string') return u;
    const t = u.trim();
    if (!t || t.startsWith('data:') || t.startsWith('blob:') || t.startsWith('javascript:') || t.startsWith('#') || t.startsWith(ORIGIN + '/p/') || t.startsWith('/p/')) return u;
    try {
      const abs = new URL(t, FINAL_HREF);
      if (abs.origin === ORIGIN && !abs.pathname.startsWith('/p/')) {
        const realAbs = new URL(abs.pathname + abs.search, FINAL_HREF);
        const proto = realAbs.protocol.slice(0, -1);
        return ORIGIN + '/p/' + proto + '/' + realAbs.host + realAbs.pathname + realAbs.search;
      }
      if (abs.protocol === 'http:' || abs.protocol === 'https:') {
        const proto = abs.protocol.slice(0, -1);
        return ORIGIN + '/p/' + proto + '/' + abs.host + abs.pathname + abs.search;
      }
    } catch (e) {}
    return u;
  }
  window.__dwToProxy = toProxy;
  window.__dwFinalHref = FINAL_HREF;

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      try {
        if (typeof input === 'string') input = toProxy(input);
        else if (input && typeof input.url === 'string') input = new Request(toProxy(input.url), input);
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, reqUrl, ...rest) {
    try { reqUrl = toProxy(String(reqUrl)); } catch (e) {}
    return origOpen.call(this, method, reqUrl, ...rest);
  };
})();
</script>
<style id="dw-force-visible">
  /* Pastikan elemen animasi scroll / lazy-load langsung terlihat saat dirender */
  [data-aos], .aos-init, .aos-animate, .reveal, .wow, .fade-in, .animate-on-scroll {
    opacity: 1 !important;
    visibility: visible !important;
    transform: none !important;
    transition: none !important;
  }
  *, *::before, *::after {
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
</style>`;

        let styleBuffer = "";

        const rewriter = new HTMLRewriter()
          .on("head", {
            element(el) {
              el.prepend(headInjection, { html: true });
            }
          })
          // Hapus meta CSP dari target agar tidak memblokir pemuatan aset via proxy
          .on("meta[http-equiv]", {
            element(el) {
              const equiv = (el.getAttribute("http-equiv") || "").toLowerCase();
              if (equiv.includes("content-security-policy") || equiv.includes("x-frame-options")) {
                el.remove();
              }
            }
          })
          // Tulis ulang semua <link> (stylesheet, preload, icon, font)
          .on("link", {
            element(el) {
              const href = el.getAttribute("href");
              if (href) {
                el.setAttribute("href", toProxyUrl(href, baseHref, origin));
              }
              el.removeAttribute("integrity");
              const rel = (el.getAttribute("rel") || "").toLowerCase();
              if (rel.includes("stylesheet") || rel.includes("preload") || rel.includes("font")) {
                el.setAttribute("crossorigin", "anonymous");
              }
            }
          })
          // Tulis ulang <img> termasuk lazy-load (data-src, srcset)
          .on("img", {
            element(el) {
              let src =
                el.getAttribute("src") ||
                el.getAttribute("data-src") ||
                el.getAttribute("data-lazy-src") ||
                el.getAttribute("data-original");

              if ((!src || src.startsWith("data:image/gif") || src.startsWith("data:image/svg")) && el.getAttribute("data-src")) {
                src = el.getAttribute("data-src");
              }

              const srcset = el.getAttribute("srcset") || el.getAttribute("data-srcset");
              if (!src && srcset) {
                const firstCandidate = srcset.split(",")[0].trim().split(/\s+/)[0];
                if (firstCandidate) src = firstCandidate;
              }

              if (src) {
                el.setAttribute("src", toProxyUrl(src, baseHref, origin));
              }
              el.setAttribute("crossorigin", "anonymous");
              el.setAttribute("loading", "eager");
              el.setAttribute("decoding", "sync");
              el.removeAttribute("srcset");
              el.removeAttribute("data-srcset");
            }
          })
          // Arahkan <source> di dalam <picture> ke proxy agar gambar tampil dengan CORS aman
          .on("picture > source", {
            element(el) {
              const srcset = el.getAttribute("srcset");
              if (srcset) {
                const firstCandidate = srcset.split(",")[0].trim().split(/\s+/)[0];
                if (firstCandidate) {
                  el.setAttribute("srcset", toProxyUrl(firstCandidate, baseHref, origin));
                } else {
                  el.remove();
                }
              }
            }
          })
          // Tulis ulang poster pada <video>
          .on("video", {
            element(el) {
              const poster = el.getAttribute("poster");
              if (poster) {
                el.setAttribute("poster", toProxyUrl(poster, baseHref, origin));
                el.setAttribute("crossorigin", "anonymous");
              }
            }
          })
          // Tulis ulang <script src="..."> agar bundle React/Vite/Tailwind CDN tetap jalan di sandbox iframe
          .on("script", {
            element(el) {
              const src = el.getAttribute("src");
              if (src) {
                const lower = src.toLowerCase();
                // Abaikan script tracker/analytics/iklan yang tidak diperlukan visual
                if (
                  lower.includes("googletagmanager") ||
                  lower.includes("google-analytics") ||
                  lower.includes("adsbygoogle") ||
                  lower.includes("clarity.ms") ||
                  lower.includes("fbevents") ||
                  lower.includes("hotjar")
                ) {
                  el.remove();
                  return;
                }
                el.setAttribute("src", toProxyUrl(src, baseHref, origin));
                el.removeAttribute("integrity");
                el.setAttribute("crossorigin", "anonymous");
              }
            }
          })
          // Tulis ulang url(...) di dalam tag <style>
          .on("style", {
            element() {
              styleBuffer = "";
            },
            text(chunk) {
              styleBuffer += chunk.text;
              if (chunk.lastInTextNode) {
                const rewritten = rewriteCssUrls(styleBuffer, baseHref, origin);
                chunk.replace(rewritten, { html: true });
                styleBuffer = "";
              } else {
                chunk.remove();
              }
            }
          })
          // Tulis ulang url(...) pada atribut inline style="..."
          .on("*[style]", {
            element(el) {
              const st = el.getAttribute("style");
              if (st && st.toLowerCase().includes("url(")) {
                el.setAttribute("style", rewriteCssUrls(st, baseHref, origin));
              }
            }
          });

        const transformed = rewriter.transform(res);
        const headers = new Headers(CORS_HEADERS);
        headers.set("Content-Type", "text/html; charset=utf-8");
        headers.set("Set-Cookie", `dw_target=${encodeURIComponent(finalUrl.origin)}; Path=/; SameSite=Lax`);

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

    // 3. Endpoint /p/:proto/:host/:path* (Proxy CSS, JS, Gambar, SVG, Font)
    if (url.pathname.startsWith("/p/")) {
      const match = url.pathname.match(/^\/p\/(https?)\/([^/]+)(\/.*)?$/);
      if (!match) {
        return new Response("Format path proxy tidak valid", { status: 400, headers: CORS_HEADERS });
      }
      const [, proto, host, path = "/"] = match;
      return fetchAndProxyAsset(proto, host, path, url.search, url.origin, request);
    }

    // 4. Sajikan file statis (public/index.html)
    const assetResponse = await env.ASSETS.fetch(request);

    // 5. Fallback: jika aset tidak ditemukan di ./public (404), proxy langsung dari origin target
    if (assetResponse.status === 404 && url.pathname !== "/" && !url.pathname.startsWith("/proxy")) {
      let targetOrigin = getCookie(request.headers.get("Cookie"), "dw_target");
      if (!targetOrigin) {
        const referer = request.headers.get("Referer");
        if (referer) {
          try {
            const refUrl = new URL(referer);
            const uParam = refUrl.searchParams.get("url");
            if (uParam) {
              const parsed = new URL(uParam.startsWith("http") ? uParam : `https://${uParam}`);
              targetOrigin = parsed.origin;
            }
          } catch {}
        }
      }

      if (targetOrigin) {
        try {
          const tUrl = new URL(targetOrigin);
          const proto = tUrl.protocol.slice(0, -1);
          return fetchAndProxyAsset(proto, tUrl.host, url.pathname, url.search, url.origin, request);
        } catch {}
      }
    }

    return assetResponse;
  }
};
