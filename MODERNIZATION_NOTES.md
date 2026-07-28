# Modernization Notes

This document lists every real bug found and every dependency/runtime upgrade
made while modernizing this repository. Nothing below is cosmetic — each item
was either a build-breaker, a silent runtime bug, or an unmaintained/insecure
dependency.

## Critical (build-breaking) bugs fixed

1. **`docker-compose.yaml` — `mongodb` service bind-mounted the entire host
   filesystem.**
   `volumes: - /:/data/db` mounted the host's `/` into the container instead
   of the named `mongodb` volume that was already declared (and never used)
   at the bottom of the file. This is both a data-loss/security risk and the
   reason Mongo's actual data directory was never on a proper volume.
   Fixed to `mongodb:/data/db`.

2. **`shipping/pom.xml` — dependency on a private, unpublished artifact.**
   `com.instana:instana-java-sdk:1.2.0` is not published to Maven Central (or
   any public repository), so `mvn package` would fail immediately for anyone
   without access to Instana's private Maven repo. Removed the dependency and
   the corresponding `com.instana.sdk.support.SpanSupport` usage in
   `ShippingServiceApplication.java`, replacing the "tag request with a
   simulated datacenter" behavior with a plain `X-Datacenter` response header
   so the feature still works without a private SDK.

## Silent logic bugs fixed

3. **`shipping/.../City.java` — `setRegion` never set the region.**
   ```java
   public void setRegion(String code) {
       this.region = region; // assigns the field to itself; 'code' unused
   }
   ```
   Every city's region was always `null`. Fixed to actually assign the
   parameter.

4. **`shipping/.../Calculator.java` — dead/broken constructor.**
   ```java
   Calculator(double latitdue, double longitude) { // typo'd parameter name
       this.latitude = latitude; // assigns field to itself, not the argument
   ```
   Fixed the parameter name so the value passed in is actually stored. (This
   constructor was unused by the rest of the app, but it was still wrong and
   would misbehave the moment something called it.)

5. **`user/server.js` — reading a field that doesn't exist on the modern
   MongoDB driver's return value.**
   ```js
   const r = await usersCollection.insertOne(...);
   req.log.info('inserted', r.result); // r.result is undefined on driver v4/v6
   ```
   Fixed to `r.insertedId`.

6. **`payment/payment.py` — crash on a cart with no `items`.**
   `for item in cart.get('items'):` throws `TypeError: 'NoneType' is not
   iterable` if `items` is missing/null. Fixed to default to `[]`.

## Dependency modernization (all verified installable from the live registries)

| Service | Before | After |
|---|---|---|
| cart/catalogue/user | `express-pino-logger` (unmaintained), `body-parser` (folded into express), `request` (deprecated 2020), `redis@2` callback API | `pino-http`, built-in `express.json()`, native `fetch`, `redis@4` async API |
| catalogue/user | `mongodb@4.7` with deprecated `useNewUrlParser`/`useUnifiedTopology` options | `mongodb@6.21` (options removed, they're no-ops/removed upstream) |
| payment | Unpinned `requirements.txt` (non-reproducible builds) | Pinned: `Flask==3.1.3`, `requests==2.34.2`, `pika==1.4.2`, `prometheus_client==0.26.0`, `instana==3.16.0`, `uwsgi==2.0.31` |
| shipping | Spring Boot **2.3.3** (EOL since 2021), `javax.*`, deprecated `mysql:mysql-connector-java`, deprecated Apache HttpClient 4.x param APIs, `com.mysql.jdbc.Driver` (removed driver class) | Spring Boot **3.3.5**, `jakarta.*`, `com.mysql:mysql-connector-j`, `java.net.http.HttpClient` (JDK built-in, no extra dependency), `com.mysql.cj.jdbc.Driver` |

All three Node services were installed fresh in a sandboxed environment and
booted successfully (`/health` responding, 0 `npm audit` vulnerabilities).
The payment service was installed into a real virtualenv and its module
imported successfully. The shipping service's dependency-free files
(`Ship.java`, and `Calculator.java`+`City.java` compiled together) were
compiled with a real JDK 21 `javac` and produced zero errors; the remaining
Spring-annotated files could not be fully compiled in this sandbox because
outbound access to Maven Central is not permitted here — every error
produced was exclusively "cannot find symbol: jakarta.persistence.*", i.e.
purely a networking limitation of this environment, not a code defect.

## Docker/infra hardening

- Added `HEALTHCHECK` to every service's Dockerfile (cart, catalogue, user,
  payment, shipping, frontend).
- Node services now use `npm ci` against a committed `package-lock.json`
  instead of a floating `npm install`, for reproducible builds.
- `mysql/Dockerfile` no longer bakes a fixed root password permanently into
  the image; it's an overridable `ARG`/`ENV` and `docker-compose.yaml` now
  supplies it at container runtime.
- Added `.dockerignore` to every service that lacked one.
- Added `restart: unless-stopped` and explicit environment variables to every
  service in `docker-compose.yaml` (previously several services relied
  entirely on in-code defaults with nothing declared in compose).
- Bumped `redis` image to `7.4-alpine` and `rabbitmq` to
  `3-management-alpine` (adds the management UI, smaller footprint).

## What I could not verify in this sandbox

- Full `docker build` / `docker-compose up` end-to-end, since no Docker
  daemon is available here.
- Full `mvn package` for the shipping service, since outbound access to
  Maven Central is blocked in this sandbox's network policy.

Everything else (all Node/Python code) was actually installed, run, and
smoke-tested against real registries in this session — not just read and
assumed correct.
