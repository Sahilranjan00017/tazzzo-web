package com.tazzzo.app.e2e

// LOCAL E2E ONLY. Copied into tazzzo-app's composeApp/src/androidUnitTest by e2e/local-stack/scripts/app-jvm.sh for one
// run and removed afterwards; never committed to the app. Skips itself unless TAZZZO_E2E_BACKEND is set, so it can never
// run in CI by accident. It exercises the app's REAL shared code (ApiClient, RemoteContentDataSource + toDomain mapping,
// RemoteCatalogDataSource + toDetail, KtorImageFetcher) against the live local backend and the CDN stand-in. It does NOT
// render Compose UI: on-device rendering is not verified by this test.

import com.tazzzo.app.catalog.installationId
import com.tazzzo.app.data.catalog.RemoteCatalogDataSource
import com.tazzzo.app.data.content.HomeBlock
import com.tazzzo.app.data.content.RemoteContentDataSource
import com.tazzzo.app.data.remote.ApiClient
import com.tazzzo.app.image.KtorImageFetcher
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import kotlinx.coroutines.runBlocking
import java.io.File
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

class LocalBackendE2ETest {
    private val backend = System.getenv("TAZZZO_E2E_BACKEND")
    private val cdn = System.getenv("TAZZZO_E2E_CDN").orEmpty()
    private val cert = System.getenv("TAZZZO_E2E_CDN_CERT").orEmpty()
    private fun list(name: String) = System.getenv(name).orEmpty().split('|').map { it.trim() }.filter { it.isNotEmpty() }

    /** The app's image client config (KtorImageFetcher's default), trusting ONLY the CDN stand-in's self-signed cert. */
    private fun imageClient(): HttpClient {
        val ca = File(cert).inputStream().use { CertificateFactory.getInstance("X.509").generateCertificate(it) }
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setCertificateEntry("cdn", ca) }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
        val tm = tmf.trustManagers.single() as X509TrustManager
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
        return HttpClient(OkHttp) {
            engine { config { sslSocketFactory(ssl.socketFactory, tm) } }
            expectSuccess = false
            followRedirects = false
            install(HttpTimeout) { connectTimeoutMillis = 10_000; requestTimeoutMillis = 20_000; socketTimeoutMillis = 15_000 }
        }
    }

    private fun describe(b: HomeBlock) = when (b) {
        is HomeBlock.Banner -> "BANNER '${b.title}' image=${b.imageUrl} link=${b.link}"
        is HomeBlock.ProductRail -> "PRODUCT_RAIL '${b.title}' ids=${b.productIds}"
        is HomeBlock.CategoryGrid -> "CATEGORY_GRID '${b.title}' ids=${b.nodeIds}"
    }

    @Test
    fun appHomeAndPdpAgainstTheLocalBackend() = runBlocking {
        if (backend.isNullOrBlank()) { println("SKIPPED: TAZZZO_E2E_BACKEND not set"); return@runBlocking }
        val checkpoint = System.getenv("E2E_APP_CHECKPOINT") ?: "unnamed"
        println("== app JVM checkpoint '$checkpoint' backend=$backend cdn=$cdn")
        val api = ApiClient(baseUrl = backend)   // engine from the classpath: OkHttp (androidMain), real HTTP
        val home = RemoteContentDataSource(api) { installationId() }.home()
        println("GET /v1/content/home?channel=app -> ${home.blocks.size} blocks (after the app's own mapping)")
        home.blocks.forEachIndexed { i, b -> println("  [$i] ${describe(b)}") }

        val titles = home.blocks.map { it.title }
        val expectOrder = list("E2E_APP_EXPECT_ORDER")
        if (expectOrder.isNotEmpty()) {
            assertEquals(expectOrder, titles.filter { it in expectOrder }, "relative order of the expected blocks")
            println("ASSERT order of $expectOrder: OK")
        }
        for (absent in list("E2E_APP_EXPECT_ABSENT")) {
            assertTrue(absent !in titles, "'$absent' must not reach the app")
            println("ASSERT absent '$absent': OK")
        }

        val fetcher = KtorImageFetcher(client = imageClient())
        val expectImages = System.getenv("E2E_APP_EXPECT_IMAGES")      // ok | unavailable
        val urls = home.blocks.filterIsInstance<HomeBlock.Banner>().map { it.imageUrl }.toMutableList()
        System.getenv("E2E_APP_PDP")?.takeIf { it.isNotBlank() }?.let { id ->
            val pdp = RemoteCatalogDataSource(api) { installationId() }.product(id, null)
            println("GET /v1/products/$id -> '${pdp.product.name}' gallery=${pdp.gallery.map { "${it.role}:${it.url}" }}")
            if (pdp.gallery.isEmpty()) fail("PDP $id has no gallery image")
            urls += pdp.gallery.first().url
        }
        for (u in urls) {
            assertTrue(u.startsWith("$cdn/"), "image url is under the CDN base: $u")
            val bytes = fetcher.fetch(u)
            val state = if (bytes == null) "Unavailable (placeholder)" else "Ready bytes=${bytes.size} magic=${bytes.take(4).joinToString(" ") { "%02x".format(it) }}"
            println("image $u -> $state")
            when (expectImages) {
                "ok" -> assertTrue(bytes != null && bytes.isNotEmpty(), "image loads: $u")
                "unavailable" -> assertTrue(bytes == null, "image is unavailable while the CDN is down: $u")
            }
        }
        println("== checkpoint '$checkpoint' PASSED")
    }
}
