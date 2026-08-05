# DECISIONS.md — Architectural Decision Record

Why the Roboshop Helmification looks the way it does. Every entry follows the
same shape: **Context → Options → Decision → Consequences**. This document is
written to be read by someone who did not do the work, including future you.

---

## ADR-001 — Library chart instead of a monolithic umbrella chart

**Context.** The original repo held ten near-identical Deployment/Service pairs.
`catalogue`, `user` and `cart` differed only in name, image tag and environment
variables — around 95% duplicated YAML. Any hardening change (say, adding a
seccomp profile) meant ten identical edits and one inevitable miss.

**Options.**

1. One umbrella chart with ten subcharts and a shared `values.yaml`.
2. One chart per service, each self-contained (duplication preserved).
3. A `type: library` chart consumed as a dependency by ten independent charts.

**Decision.** Option 3.

**Why not option 1.** An umbrella chart makes the whole platform one Helm
release. Bumping the `catalogue` image would produce a new revision of
*everything*, `helm rollback` would roll back *everything*, and a bad template
in `payment` would block a `frontend` hotfix. It also fights ArgoCD, which is
happiest with small Applications that report health independently.

**Why not option 2.** It is the status quo with extra steps.

**Consequences.**

* Adding a resource type to all eleven charts is one file in `charts/common`.
* Each service is independently versioned, released and rolled back.
* Cost: consumers must run `helm dependency build`; CI does this first, and the
  Makefile's `deps` target hides it locally.
* Cost: an extra indirection when debugging — `helm template` output is the
  source of truth, and CI publishes it as an artifact for exactly this reason.

---

## ADR-002 — Preserve resource names and `app:` selector labels

**Context.** Helm's convention is `{{ .Release.Name }}-{{ .Chart.Name }}` and
`app.kubernetes.io/name` selectors. The live cluster has Services named
`catalogue`, `mongodb`, `redis` and pods labelled `app: catalogue`. The
application's configuration hardcodes DNS names such as
`mongodb://mongodb:27017/catalogue` and `REDIS_HOST=redis`.

**Decision.** Pin `fullnameOverride` to the bare service name and keep
`app: <name>` in `common.selectorLabels`, alongside the standard
`app.kubernetes.io/*` labels.

**Rationale.**

* `spec.selector` on a Deployment and `spec.selector`/`spec.ports` identity on a
  Service are **immutable**. Changing them is not an upgrade — it is a delete
  and recreate, i.e. downtime plus a new ALB target group.
* Renaming Services would break in-cluster DNS for every hardcoded connection
  string, turning a packaging exercise into an application change.
* The existing NetworkPolicies and PDBs select on `app:`. Dropping it would
  silently un-protect and un-firewall every pod.

**Consequences.** Two charts cannot be installed into the same namespace twice.
That is acceptable — environments are separated by namespace. An escape hatch
exists: `useReleaseNamePrefix: true` restores Helm-conventional naming.

**Rule that came out of this.** Selector labels contain *only* stable identity.
Never `version`, `helm.sh/chart` or `environment` — otherwise every chart
version bump becomes an immutable-field conflict.

---

## ADR-003 — Separate `platform` chart for shared infrastructure

**Context.** Namespace, ResourceQuota, LimitRange, StorageClass, the shared
ConfigMap, the shared Secret, the ALB Ingress and the baseline NetworkPolicies
are singletons. Ten charts cannot each own them.

**Options.** (a) Put them in the first chart installed. (b) Duplicate with
`lookup` guards. (c) A dedicated `platform` chart at sync wave `-1`.

**Decision.** Option (c).

**Rationale.** Shared resources have a different lifecycle *and a different
owner* from application code. The platform team changes quotas and certificate
ARNs; product teams change image tags. Splitting the charts splits the blast
radius and the RBAC. Uninstalling `catalogue` must never delete the namespace.

**Consequences.**

* `platform` must be installed first — encoded as ArgoCD sync wave `-1` and as
  ordering in `make install`.
* Internal ordering inside `platform` uses waves `-10 … 5`: namespace, then
  quota/limits/storage, then service account, then config, then secrets, then
  network policies, then the Ingress last (wave `5`) so backend Services exist
  before the ALB controller tries to build target groups.
* Uninstalling `platform` is destructive by design; production ArgoCD sync is
  manual and `prune: false`.

---

## ADR-004 — Independent charts for datastores, not Bitnami dependencies

**Context.** Bitnami publishes mature MongoDB/MySQL/Redis/RabbitMQ charts.

**Decision.** Keep hand-written StatefulSet charts rendered from `common`.

**Rationale.**

* **Behaviour preservation is the brief.** Bitnami charts change images, ports,
  init logic, auth model, secret names and volume layout. Swapping them in is a
  data-plane migration, not a packaging change.
* Bitnami charts are large and opinionated; the failure mode is a values file
  nobody understands.
* Supply chain: the Bitnami catalogue's free tier has been repeatedly re-scoped.
  Depending on it is a business risk for a production platform.

**Consequences.** We own replication, backup and upgrade logic — which we do
*not* implement, because the original project did not either. This is called out
explicitly in ADR-010.

---

## ADR-005 — Security controls are hardcoded, not parameterised

**Context.** The natural Helm instinct is to expose every field as a value.

**Decision.** `runAsNonRoot: true`, `allowPrivilegeEscalation: false`,
`privileged: false`, `capabilities.drop: [ALL]` and
`seccompProfile: RuntimeDefault` are literals inside `common.podSecurityContext`
and `common.containerSecurityContext`. They cannot be overridden from values.

**Rationale.** A security control that can be disabled by a values file *will*
be disabled by a values file, at 2am, to make something work. Baking it into the
template means turning it off requires a reviewed change to the library chart —
which is exactly the level of scrutiny that decision deserves.

**Deliberate exceptions, each justified:**

* `readOnlyRootFilesystem` is a value. Stock MySQL, MongoDB and RabbitMQ images
  write to paths outside their data volume and cannot start read-only. All six
  application charts set it to `true` and mount an `emptyDir` at `/tmp`.
* RabbitMQ has a `volume-permissions` init container running as root (UID 0) to
  `chown` the EBS volume, because the Erlang cookie needs `0600` ownership by
  UID 999. It runs `runAsNonRoot: false` *only for that init container*; the app
  container stays hardened. This mirrors the original manifest.
* `automountServiceAccountToken: false` everywhere. No Roboshop workload talks
  to the Kubernetes API, so shipping it a token is pure attack surface.

---

## ADR-006 — Secrets by reference: External Secrets Operator, with a CSI fallback

**Context.** The original `secrets.yaml` contained base64-encoded JWT signing
keys, the MySQL root password and RabbitMQ credentials — committed to Git.
Base64 is encoding, not encryption. Anyone with repo read access had production
credentials.

**Options.** Sealed Secrets, SOPS + age, External Secrets Operator (ESO),
Secrets Store CSI Driver with the AWS provider.

**Decision.** ESO by default, CSI as a supported alternative, plus an `existing`
mode that renders neither.

**Rationale.**

* ESO keeps the *source of truth* in AWS Secrets Manager, where rotation,
  audit (CloudTrail), cross-account policy and KMS encryption already exist.
  Nothing sensitive — not even ciphertext — enters Git.
* `refreshInterval: 15m` means a rotation in Secrets Manager propagates without
  a redeploy.
* Sealed Secrets and SOPS both still put ciphertext in Git and make rotation a
  commit. Rejected.
* CSI is offered because some organisations mandate it (secrets never become
  Kubernetes Secret objects at all). It is a values switch, not a fork.

**The key design property:** all three modes converge on one Secret name,
`roboshop-secrets`, with the same keys. Service charts reference it via
`secretKeyRef` and are completely unaware of which mechanism filled it.
Switching modes is a platform-chart change; no application chart moves.

**Consequences.** A hard dependency on ESO (or the CSI driver) being installed
in the cluster, and on an IRSA role granting
`secretsmanager:GetSecretValue` + `kms:Decrypt`. Documented as a prerequisite.

---

## ADR-007 — IRSA over node instance profiles

**Context.** Pods need AWS access (Secrets Manager today; S3/SQS plausibly
tomorrow).

**Decision.** A ServiceAccount annotated with
`eks.amazonaws.com/role-arn`, one role per workload identity.

**Rationale.** The alternative — permissions on the node instance profile —
grants those permissions to *every pod on the node*, including a compromised
sidecar. IRSA scopes credentials to a ServiceAccount via the OIDC provider, with
short-lived tokens that rotate automatically and per-pod CloudTrail attribution.

**Consequences.** Requires an OIDC provider on the cluster and a trust policy
per role. The ARN is empty by default so the charts install on a non-EKS cluster
(kind, minikube) without modification; the annotation is only emitted when the
value is non-empty.

---

## ADR-008 — One shared ALB via IngressGroup

**Context.** Six services need external routing. Naively, six Ingress objects
means six ALBs at roughly $17/month each plus six sets of certificates, WAF
associations and DNS records.

**Decision.** A single Ingress in the platform chart with
`alb.ingress.kubernetes.io/group.name: roboshop` and path-based rules, using
`target-type: ip`.

**Rationale.**

* IngressGroup lets the AWS Load Balancer Controller merge rules onto one ALB.
* `target-type: ip` registers pod IPs directly — one fewer network hop than
  `instance` mode, no `NodePort`, and it works with `ClusterIP` Services (which
  is why every Service stays `ClusterIP`).
* Centralising the Ingress means TLS policy, WAF and idle timeouts are set in
  one reviewed place rather than copy-pasted across six annotations blocks.
* The Ingress renders at sync wave `5` — after all backend Services exist — so
  the controller never creates a target group pointing at nothing.

**Consequences.** Adding a route is a platform-chart change, which is a mild
coupling. Accepted: routing *is* a platform concern, and `group.order` remains
available if a team ever needs its own Ingress object in the same group.

---

## ADR-009 — gp3 StorageClass with `WaitForFirstConsumer`

**Decision.** A `gp3` class: `encrypted: true`, `3000` IOPS, `125` MB/s
throughput, `allowVolumeExpansion: true`, `reclaimPolicy: Retain`,
`volumeBindingMode: WaitForFirstConsumer`.

**Rationale.**

* gp3 is ~20% cheaper than gp2 and decouples IOPS from volume size — gp2 gives
  3 IOPS/GB, so matching gp3's baseline on gp2 requires a 1TB volume.
* `WaitForFirstConsumer` is the important one: with `Immediate`, EBS provisions
  the volume in an arbitrary AZ and the pod can become permanently unschedulable
  because EBS volumes are zonal. Deferring binding until the scheduler picks a
  node guarantees they agree.
* `Retain` on production means a `helm uninstall` typo does not delete customer
  data. Dev and qa use `Delete` to avoid orphaned-volume cost.
* `encrypted: true` is non-negotiable for anything holding user or order data.

---

## ADR-010 — In-cluster datastores are preserved, and explicitly flagged

**Context.** The existing platform runs MongoDB, MySQL, Redis and RabbitMQ as
single-replica in-cluster StatefulSets.

**Decision.** Chart them faithfully. Document, prominently, that this is not a
production-grade data tier.

**Rationale.** The brief is "preserve current behaviour". Silently swapping in
RDS would be an unrequested, unreviewable, data-losing change. But shipping a
single-replica database with no backup, no failover and no PITR without saying
so would be malpractice.

**The honest assessment:** a single-replica StatefulSet on an EBS volume means a
node failure causes minutes of downtime while the volume reattaches, and a
volume failure means total data loss. There is no automated backup here.

**Recommended production path:** DocumentDB (or MongoDB Atlas), RDS MySQL
Multi-AZ, ElastiCache Redis, Amazon MQ for RabbitMQ. Because every connection
string comes from the shared `roboshop-config` ConfigMap, migrating is: point
the ConfigMap at the managed endpoints, set `enabled: false` on the four
datastore charts, restart the consumers. No application chart changes.

---

## ADR-011 — Four environments as values overlays, not four branches

**Context.** dev, qa, staging and production must differ in size, replica
counts, TLS, node placement and disruption policy.

**Options.** A branch per environment; a directory of full copies per
environment; layered values files.

**Decision.** `values.yaml` (safe defaults) → `charts/<svc>/values-<env>.yaml`
(what differs) → `environments/<env>/global-values.yaml` (cross-chart facts).

**Rationale.** Branch-per-environment guarantees drift: a fix lands in dev and
someone forgets the cherry-pick to production. Full copies guarantee drift for
the same reason. Layered values means environment files contain *only the
delta*, so a diff of two environments is short enough to review honestly.

**Consequences.** File ordering matters and is fixed in the Makefile, the CI
scripts and the ArgoCD ApplicationSet `valueFiles` list, so local runs and
GitOps produce identical output.

---

## ADR-012 — ArgoCD ApplicationSet with sync waves, not a Helm umbrella

**Decision.** One `ApplicationSet` per environment, list generator, one
Application per chart, waves `-1 / 0 / 1 / 2`.

**Rationale.** Helm has no cross-release ordering, and `helm install --wait`
inside a script is not a reconciliation loop. ArgoCD waits for every resource in
a wave to report Healthy before starting the next, which is precisely the
dependency semantics needed: datastores ready before the APIs that dial them,
Services present before the ALB registers targets.

**Supporting choices:**

* `ignoreDifferences` on `/spec/replicas`. Without it, every HPA scaling event
  shows the Application as OutOfSync, and with self-heal enabled ArgoCD fights
  the HPA. This is the single most common ArgoCD+HPA bug.
* `ServerSideApply=true` — avoids the `last-applied-configuration` annotation
  size limit on large CRDs and gives proper field-manager conflict detection.
* Progressive policy: dev/qa auto-sync with prune and self-heal (fast feedback,
  cheap blast radius); staging auto-syncs without prune; production is
  **manual**, so a human approves each production change while Git remains the
  only source of desired state.
* Retry with exponential backoff (10s → 5m, 5 attempts) absorbs transient
  webhook and API-server unavailability instead of parking in Degraded.

---

## ADR-013 — CI validates, CD is ArgoCD; the pipeline never touches a cluster

**Decision.** GitHub Actions runs lint → template → kubeconform → checkov →
package/push. No `kubectl apply`, no `helm upgrade`.

**Rationale.** A pipeline with cluster credentials is a pipeline that is a
tier-0 attack path. Pull-based GitOps inverts it: the cluster reaches out to
Git, and CI only needs read access to the repo and write access to a registry.
It also means the deployed state is always exactly what is in Git — no
out-of-band `kubectl` drift.

**The four gates, and what each actually catches:**

| Gate | Catches |
|------|---------|
| `helm lint --strict` | Template syntax, undefined values, schema violations |
| `helm template` | Runtime rendering failures that `lint` misses, per environment |
| `kubeconform -strict` | Wrong `apiVersion`, misspelled fields, deprecated APIs — with `-strict` rejecting unknown fields, which is how typos like `resource:` get caught |
| `checkov` | Policy: missing probes, missing limits, privileged containers |

They are genuinely different failure classes; running only one is a false sense
of safety.

**Auth.** GitHub OIDC → AWS IAM role. No long-lived access keys in secrets.

**Checkov skips are documented in `ci/checkov.yaml` with reasons.** `CKV_K8S_22`
(read-only root filesystem) is skipped globally because the datastore images
cannot satisfy it; every application chart sets it to `true` regardless.
`CKV_K8S_43` (digest pinning) is skipped because charts keep human-readable tags
in Git and the CD pipeline resolves them to digests at release time.

---

## ADR-014 — HPA on stateless services only, and never on the datastores

**Decision.** HPAs for `frontend`, `catalogue`, `user` and `cart`. Fixed
replicas for `shipping` and `payment`. Never for a StatefulSet.

**Rationale.** Horizontal scaling requires statelessness. Scaling a
single-primary MySQL StatefulSet does not add capacity — it adds an unreplicated
second instance pointed at a different volume, which is a data corruption
incident, not a scaling event.

`shipping` (JVM) and `payment` are left at fixed replicas because their startup
cost is high enough that reactive CPU-based scaling would thrash; they are sized
for peak instead.

`autoscaling/v2` with a `behavior` block: scale-up is allowed to be fast,
scale-down uses a 300s stabilisation window so a brief traffic dip does not
evict warm pods that are needed again 30 seconds later.

---

## ADR-015 — Default-deny NetworkPolicy, preserved verbatim

**Decision.** Carry the original policy set into the platform chart, unchanged
in effect: `default-deny-ingress`, `allow-dns`, `allow-alb-to-frontend`,
`allow-alb-to-backend`, `allow-service-to-service`, `allow-services-to-datastores`.

**Rationale.** Default-deny means a compromised `frontend` pod cannot reach
MySQL, because no policy permits it. This is the difference between an incident
and a breach. Templating them from `common.networkpolicy` makes adding a service
a values edit rather than a hand-written policy — which is what keeps the
default-deny posture from being quietly abandoned as the system grows.

`allow-dns` is separate and explicit: forget egress to `kube-dns` on 53/UDP+TCP
under a default-deny egress policy and every service fails name resolution in a
way that looks like an application bug.

---

## ADR-016 — PodDisruptionBudgets scaled per environment

**Decision.** No PDB in dev; `minAvailable: 1` in qa and staging;
`minAvailable: 2` in production.

**Rationale.** PDBs constrain *voluntary* disruption — node drains, cluster
upgrades, Karpenter consolidation. Without one, draining a node can take the
last replica of a service down.

The trap: `minAvailable` equal to `replicaCount` makes the node **undrainable**,
which blocks cluster upgrades indefinitely. Production runs 3 replicas with
`minAvailable: 2`, leaving exactly one pod of drain headroom. Dev has one
replica, so any PDB there would simply block drains for no availability benefit.

---

## ADR-017 — Startup probes, and why liveness probes were not just loosened

**Context.** `shipping` is a Spring Boot service that needs up to three minutes
to become ready. The obvious fix is a long `initialDelaySeconds` on the liveness
probe.

**Decision.** A `startupProbe` with `failureThreshold: 60`, `periodSeconds: 3`
(a 180s budget), plus a *tight* liveness probe that only takes effect afterwards.

**Rationale.** `initialDelaySeconds` is a fixed tax: it delays the liveness probe
on every restart, including fast ones, and it degrades detection of a genuine
hang to "eventually". A startup probe gives slow-start services a generous
one-time budget while keeping steady-state failure detection aggressive. This is
what startup probes were added to Kubernetes for.

---

## ADR-018 — `REDIS_PORT` is pinned as an explicit environment variable

**Context.** Kubernetes injects legacy Docker-link environment variables for
every Service in the namespace. A Service named `redis` produces
`REDIS_PORT=tcp://10.100.x.x:6379`. Node.js Redis clients read `REDIS_PORT`,
parse `tcp://...` as a port number and crash with `ERR_SOCKET_BAD_PORT`.

**Decision.** `charts/cart/values.yaml` sets `env.REDIS_PORT: "6379"` explicitly.
Explicit `env` entries are rendered after `envFrom` and win.

**Rationale.** This is a genuinely subtle production failure — it depends on
Service naming and manifests as an application crash with no obvious link to
Kubernetes. It is recorded here, in the values file comment, and in the README
troubleshooting table precisely so that nobody "cleans it up" later.

**Generalisation.** Any Service whose uppercased name collides with an
environment variable the application reads is a landmine. Pin the variable.

---

## What was deliberately *not* changed

Preserving behaviour means declining to fix things that are out of scope. Each
of these is a known gap with an owner-facing recommendation, not an oversight:

| Not changed | Why | Recommendation |
|-------------|-----|----------------|
| Single-replica datastores | Behaviour preservation (ADR-010) | Move to RDS / DocumentDB / ElastiCache / Amazon MQ |
| No backup or PITR | None existed before | AWS Backup on the EBS volumes, or managed-service snapshots |
| No service mesh / mTLS | None existed before | Consider Istio or Linkerd if east-west encryption is required |
| No distributed tracing | None existed before | OpenTelemetry sidecar or auto-instrumentation → X-Ray |
| `frontend` does not proxy `/api/*` | The ALB routes; nginx serves static | Keep — one fewer hop |
| Image tags, not digests, in Git | Readability of diffs | CD resolves tags to digests at release; `image.digest` is supported |
| Namespace-per-environment, one cluster | Matches current topology | Cluster-per-environment for stronger production isolation |

---

## Summary of the reasoning style

Three principles drove nearly every decision above:

1. **Immutability constrains migrations.** Selectors, Service identity and
   `volumeClaimTemplates` cannot be changed in place. Any design that requires
   changing them converts a packaging change into an outage.
2. **A control you can disable from a values file is not a control.** Security
   defaults belong in templates; only genuine, justified exceptions become
   values, and each one is documented at the point of use.
3. **Ordering is a controller's job, not a script's.** Sync waves express
   dependencies declaratively and survive partial failure; a bash loop with
   `--wait` does not.
