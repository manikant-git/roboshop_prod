# Roboshop Helm

Production Helm packaging for the Roboshop microservices platform on Amazon EKS.

This repository is a **like-for-like Helmification** of the previously hand-maintained
`kubernetes/*.yaml` manifests. No service was merged, renamed, redesigned or
re-scoped. Resource names, DNS names, ports, probes, security contexts and
network policies are byte-equivalent in behaviour to the pre-Helm stack; what
changed is that ~1,300 lines of duplicated YAML now live in one library chart
and are parameterised for four environments.

---

## Table of contents

1. [Architecture](#architecture)
2. [Repository layout](#repository-layout)
3. [Chart model](#chart-model)
4. [Installation](#installation)
5. [Upgrade](#upgrade)
6. [Rollback](#rollback)
7. [Configuration reference](#configuration-reference)
8. [Secrets](#secrets)
9. [Ingress](#ingress)
10. [GitOps with ArgoCD](#gitops-with-argocd)
11. [CI/CD](#cicd)
12. [Troubleshooting](#troubleshooting)
13. [FAQ](#faq)
14. [Best practices](#best-practices)

---

## Architecture

### Application topology

```text
                          Internet
                              |
                        HTTPS / HTTP
                              |
                   +---------------------+
                   |  AWS ALB (ingress)  |   group.name = roboshop
                   +---------------------+
                              |
        +---------+-----------+-----------+-----------+---------+
        |         |           |           |           |         |
     /  |  /api/catalogue  /api/user   /api/cart  /api/payment  /api/shipping
        |         |           |           |           |         |
  +----------+ +---------+ +------+ +---------+ +---------+ +----------+
  | frontend | |catalogue| | user | |  cart   | | payment | | shipping |
  | nginx:80 | | :8080   | |:8080 | | :8080   | | :8080   | | :8080    |
  +----------+ +---------+ +------+ +---------+ +---------+ +----------+
                    |          |         |           |           |
                    |          |         |           |           |
              +-----+----+  +--+---+  +--+----+  +---+-----+  +--+-----+
              | mongodb  |  |mongodb| | redis |  | rabbitmq|  | mysql  |
              | catalogue|  | users | | :6379 |  |  :5672  |  | :3306  |
              |  :27017  |  |:27017 | +-------+  +---------+  +--------+
              +----------+  +-------+
```

| Service     | Language      | Port  | Depends on                       | Scaling            |
|-------------|---------------|-------|----------------------------------|--------------------|
| `frontend`  | nginx (static)| 80→8080 | ALB only (API routing is at the ALB) | HPA 2–10 @70% CPU |
| `catalogue` | Node.js       | 8080  | MongoDB (`catalogue` db)         | HPA 2–8 @70% CPU   |
| `user`      | Node.js       | 8080  | MongoDB (`users` db), Redis, JWT secrets | HPA 2–8 @70% CPU |
| `cart`      | Node.js       | 8080  | Redis, catalogue                 | HPA 2–8 @70% CPU   |
| `shipping`  | Java / Spring | 8080  | MySQL, cart                      | Fixed replicas     |
| `payment`   | Python        | 8080  | RabbitMQ, cart, user, AMQP creds | Fixed replicas     |
| `mongodb`   | StatefulSet   | 27017 | gp3 PVC 10Gi, headless Service   | Single replica     |
| `mysql`     | StatefulSet   | 3306  | gp3 PVC 10Gi, headless Service   | Single replica     |
| `redis`     | StatefulSet   | 6379  | gp3 PVC 5Gi                      | Single replica     |
| `rabbitmq`  | StatefulSet   | 5672 / 15672 | gp3 PVC 5Gi, root init container for volume perms | Single replica |

### Traffic and security boundaries

* A **single ALB** (`group.name: roboshop`) terminates client traffic and does
  path-based routing. `frontend` serves static assets only; it does **not**
  proxy `/api/*` in cluster.
* NetworkPolicy baseline: `default-deny-ingress` for the whole namespace, then
  explicit allows for DNS egress, ALB→frontend, ALB→backend, service↔service,
  and services→datastores on 27017/3306/6379/5672.
* Every pod runs non-root with `allowPrivilegeEscalation: false`, all Linux
  capabilities dropped and the `RuntimeDefault` seccomp profile. Stateless
  services additionally run with a read-only root filesystem plus an `emptyDir`
  at `/tmp`.
* `automountServiceAccountToken: false` everywhere — no workload talks to the
  API server.

---

## Repository layout

```text
roboshop-helm/
├── charts/
│   ├── common/           library chart - every reusable template lives here
│   ├── platform/         namespace, quota, limits, storage class, shared
│   │                     config, secrets integration, ALB ingress, netpols
│   ├── catalogue/        one independent chart per microservice
│   ├── user/
│   ├── cart/
│   ├── shipping/
│   ├── payment/
│   ├── frontend/
│   ├── mongodb/          one independent chart per datastore
│   ├── mysql/
│   ├── redis/
│   └── rabbitmq/
├── environments/
│   ├── dev/              global-values.yaml + releases.yaml + README
│   ├── qa/
│   ├── staging/
│   └── production/
├── argocd/
│   ├── projects/         AppProject guardrails
│   ├── applications/     app-of-apps roots (one per environment)
│   └── applicationsets/  fan-out to one Application per chart, with sync waves
├── ci/                   lint / template / kubeconform / checkov / package
├── .github/workflows/    helm-ci.yaml, helm-release.yaml
├── Makefile
├── README.md
├── DECISIONS.md
└── INTERVIEW_GUIDE.md
```

Each service chart contains exactly:

```text
charts/<service>/
├── Chart.yaml
├── values.yaml
├── values-dev.yaml
├── values-qa.yaml
├── values-staging.yaml
├── values-production.yaml
└── templates/
    ├── _helpers.tpl
    ├── NOTES.txt
    ├── deployment.yaml | statefulset.yaml
    ├── service.yaml
    ├── serviceaccount.yaml
    ├── hpa.yaml
    ├── pdb.yaml
    ├── networkpolicy.yaml
    ├── configmap.yaml
    ├── pvc.yaml
    ├── ingress.yaml
    ├── externalsecret.yaml
    └── secretproviderclass.yaml
```

Every template file is a one-line `include` of a `common.*` definition. Adding
a capability to all eleven charts is a single edit in `charts/common`.

---

## Chart model

### `common` (library chart, `type: library`)

Renders nothing on its own. Provides:

| Template | Purpose |
|----------|---------|
| `common.deployment` | Rolling-update Deployment with hardened pod spec |
| `common.statefulset` | StatefulSet with `volumeClaimTemplates` |
| `common.service` | ClusterIP / headless Service with annotations |
| `common.serviceaccount` | Optional per-chart ServiceAccount |
| `common.hpa` | `autoscaling/v2` HPA with CPU/memory/custom metrics + behavior |
| `common.pdb` | PodDisruptionBudget |
| `common.networkpolicy` | Per-service NetworkPolicy |
| `common.pvc` | Standalone PVC (for Deployments that need storage) |
| `common.configmap` | Key/value and whole-file ConfigMaps |
| `common.externalsecret` | External Secrets Operator `ExternalSecret` |
| `common.secretproviderclass` | Secrets Store CSI `SecretProviderClass` |
| `common.ingress` | AWS ALB Ingress with the full annotation set |
| `common.labels` / `common.selectorLabels` | Recommended label set; selector labels stay immutable |
| `common.fullname` / `common.name` / `common.chart` | Naming |
| `common.image` | `registry/repository:tag` or `@digest` |
| `common.podSecurityContext` / `common.containerSecurityContext` | Fixed hardening |
| `common.env` / `common.envFrom` | ConfigMap/Secret key wiring |
| `common.probes`, `common.scheduling`, `common.annotations` | Shared fragments |

### `platform` (application chart, sync wave `-1`)

Owns everything shared and cluster-scoped-ish:

* `Namespace`, `ResourceQuota`, `LimitRange`
* `StorageClass` `gp3` (encrypted, `WaitForFirstConsumer`, expandable)
* `IngressClass` `alb`
* Shared `ServiceAccount` `roboshop` (IRSA-ready)
* Shared `ConfigMap` `roboshop-config` — infrastructure wiring only
* Secret delivery: `ExternalSecret` **or** `SecretProviderClass` → Secret `roboshop-secrets`
* The single ALB `Ingress`
* The six baseline `NetworkPolicy` objects

### Service charts

Independent, individually installable and individually versioned. They never
create shared resources; they only *reference* `roboshop-config`,
`roboshop-secrets` and the `roboshop` ServiceAccount.

---

## Installation

### Prerequisites

* EKS 1.29+ with the **AWS Load Balancer Controller** and **EBS CSI driver**
* **metrics-server** (required by the HPAs)
* **External Secrets Operator** (default secret mode) *or* the
  **Secrets Store CSI Driver** with the AWS provider
* An AWS Secrets Manager secret per environment: `roboshop/<env>/app` with keys
  `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `MYSQL_ROOT_PASSWORD`,
  `AMQP_USER`, `AMQP_PASS`, `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS`
* `helm` 3.14+, `kubectl`, and (for CI) `kubeconform` + `checkov`

### Whole environment

```bash
make install ENV=dev          # dev | qa | staging | production
```

`make install` walks the charts in sync-wave order (platform → datastores →
microservices → frontend) with `--wait`, mirroring what ArgoCD does.

### Single chart

```bash
helm dependency build charts/catalogue

helm upgrade --install catalogue charts/catalogue \
  --namespace roboshop-dev --create-namespace \
  -f environments/dev/global-values.yaml \
  -f charts/catalogue/values-dev.yaml \
  --wait --timeout 10m
```

Values precedence (last wins): `values.yaml` → `values-<env>.yaml` →
`environments/<env>/global-values.yaml` → `--set` flags.

### Dry run

```bash
make template            # renders everything into ci/_rendered/
make validate            # + kubeconform schema validation
make scan                # + checkov policy scan
```

---

## Upgrade

```bash
# 1. Preview the diff (requires the helm-diff plugin)
make diff ENV=production

# 2. Apply
helm upgrade catalogue charts/catalogue -n roboshop \
  -f environments/production/global-values.yaml \
  -f charts/catalogue/values-production.yaml \
  --atomic --timeout 10m
```

* `--atomic` rolls back automatically if the release does not become ready.
* `maxUnavailable: 0` / `maxSurge: 1` plus PDBs mean zero-downtime rollouts.
* Bumping only an image tag: `--set image.tag=2.0.2` — but in GitOps mode edit
  `charts/<svc>/values-<env>.yaml` and let ArgoCD reconcile.
* StatefulSet storage: `volumeClaimTemplates` are immutable. Changing
  `persistence.size` requires expanding the PVCs manually (allowed, the
  StorageClass sets `allowVolumeExpansion: true`) and then patching the
  StatefulSet with `--cascade=orphan`.

---

## Rollback

```bash
helm history catalogue -n roboshop
helm rollback catalogue 7 -n roboshop --wait
# or
make rollback ENV=production RELEASE=catalogue
```

Under ArgoCD, prefer rolling back Git (revert the commit) so the desired state
and the cluster stay in agreement; a manual `helm rollback` will be reverted by
self-heal in dev/qa.

---

## Configuration reference

Values that are intentionally parameterised:

| Key | Meaning |
|-----|---------|
| `image.registry` / `image.repository` / `image.tag` / `image.digest` / `image.pullPolicy` | Image coordinates |
| `replicaCount` | Static replica count (ignored when `autoscaling.enabled`) |
| `resources.requests/limits` | CPU + memory |
| `autoscaling.*` | HPA min/max, CPU/memory targets, `behavior` |
| `podDisruptionBudget.*` | `minAvailable` / `maxUnavailable` |
| `service.type/ports/annotations/headless` | Service shape |
| `persistence.*` | `storageClass`, `size`, `accessModes`, `mountPath` |
| `ingress.*` (platform) | Hostname, certificate ARN, SSL redirect, health checks, tags, WAF |
| `env`, `envFrom`, `envFromConfigMapKeys`, `envFromSecretKeys` | Application configuration |
| `nodeSelector`, `affinity`, `tolerations`, `topologySpreadConstraints`, `priorityClassName` | Scheduling |
| `namespace`, `serviceAccount.*` | Placement and identity |
| `containerPorts` | Ports |

Values that are intentionally **not** parameterised (security defaults enforced
by the library chart): `runAsNonRoot`, `allowPrivilegeEscalation`,
`privileged`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`.
`readOnlyRootFilesystem` is a value only because the stock MySQL/MongoDB/
RabbitMQ images cannot start without a writable root; every application chart
sets it to `true`.

### Environment profiles

| | dev | qa | staging | production |
|---|---|---|---|---|
| Namespace | `roboshop-dev` | `roboshop-qa` | `roboshop-staging` | `roboshop` |
| Replicas | 1 | 2 | 2 | 3 |
| HPA | off | 2–4 @70% | 2–6 @70% | 3–12 @60% |
| PDB | off | `minAvailable: 1` | `minAvailable: 1` | `minAvailable: 2` |
| Spread | best-effort | best-effort | best-effort | `DoNotSchedule` across zones |
| Storage | 5Gi / 2Gi | 10Gi / 5Gi | 20Gi / 10Gi | 100Gi / 50Gi |
| TLS | HTTP only | HTTP only | ACM cert + redirect | ACM cert + redirect + WAF |
| Node placement | any | any | any | tainted `workload=roboshop` nodes |
| ArgoCD | auto-sync + prune + self-heal | same | auto-sync, no prune | manual sync |

---

## Secrets

**No credential is ever committed.** `charts/platform/values.yaml` contains only
the *name* of the remote secret and the list of keys to project.

Default mode — External Secrets Operator:

```yaml
secrets:
  mode: external-secrets
  name: roboshop-secrets
  externalSecrets:
    secretStoreRef: { name: aws-secretsmanager, kind: ClusterSecretStore }
    remoteKey: roboshop/production/app
    refreshInterval: 15m
    keys: [JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, MYSQL_ROOT_PASSWORD, ...]
```

Alternative — Secrets Store CSI Driver:

```bash
helm upgrade --install platform charts/platform -n roboshop \
  -f charts/platform/values-production.yaml \
  --set secrets.mode=csi --set secrets.csi.enabled=true
```

Third mode — `secrets.mode=existing`: neither object is rendered and the charts
simply reference a Secret created out-of-band by the platform team.

Workloads always consume the *same* Secret name (`roboshop-secrets`) through
`secretKeyRef`, so switching modes never touches a service chart.

---

## Ingress

One ALB fronts the whole application (`alb.ingress.kubernetes.io/group.name`).
Parameterised in `charts/platform/values-<env>.yaml`:

```yaml
ingress:
  alb:
    loadBalancerName: roboshop-alb
    scheme: internet-facing
    targetType: ip
    listenPorts: '[{"HTTP":80},{"HTTPS":443}]'
    certificateArn: arn:aws:acm:us-east-1:...:certificate/...
    sslRedirect: "443"
    sslPolicy: ELBSecurityPolicy-TLS13-1-2-2021-06
    wafv2AclArn: arn:aws:wafv2:...
    healthcheck: { protocol: HTTP, path: /health, intervalSeconds: 15, ... }
    loadBalancerAttributes: idle_timeout.timeout_seconds=60,routing.http2.enabled=true,...
    tags: { Project: roboshop, Environment: production }
  hosts:
    - host: shop.streenzo.online
      paths: [ ... ]
```

`certificateArn: ""` (dev/qa) renders an HTTP-only listener, exactly like the
original manifest with its commented-out TLS annotations.

---

## GitOps with ArgoCD

```bash
kubectl apply -f argocd/projects/roboshop-project.yaml
kubectl apply -f argocd/applications/root-production.yaml
```

The root Application renders `argocd/applicationsets/roboshop-<env>.yaml`, which
generates one Application per chart. Sync waves:

| Wave | Contents |
|------|----------|
| `-1` | `platform` |
| `0`  | `mongodb`, `mysql`, `redis`, `rabbitmq` |
| `1`  | `catalogue`, `user`, `cart`, `shipping`, `payment` |
| `2`  | `frontend` |
| `5`  | Shared ALB Ingress (inside `platform`) |

`/spec/replicas` is in `ignoreDifferences` so HPA activity never registers as
drift. See `argocd/README.md`.

---

## CI/CD

`.github/workflows/helm-ci.yaml` runs on every PR touching `roboshop-helm/`:

1. `helm dependency build` for all charts
2. `helm lint --strict` for every chart × every environment values file
3. `helm template` → `ci/_rendered/<env>/<chart>.yaml` (uploaded as an artifact)
4. `kubeconform -strict` against the Kubernetes 1.30 schemas plus the
   CRDs-catalog for `ExternalSecret` / `SecretProviderClass`
5. `checkov --framework kubernetes` with documented, justified skips
6. On `main`: `helm package` + `helm push` to ECR as OCI artifacts (AWS OIDC,
   no long-lived credentials)

`.github/workflows/helm-release.yaml` publishes immutable chart versions on
`roboshop-v*` tags. Neither workflow ever runs `helm upgrade` against a
cluster — ArgoCD owns deployment.

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `Error: found in Chart.yaml, but missing in charts/ directory: common` | Dependency not vendored | `helm dependency build charts/<svc>` |
| Pod `CreateContainerConfigError` | `roboshop-secrets` not materialised yet | `kubectl -n <ns> describe externalsecret roboshop-secrets`; check the ClusterSecretStore and the IRSA role's `secretsmanager:GetSecretValue` |
| Pod `CrashLoopBackOff` on `cart` with `ERR_SOCKET_BAD_PORT` | Kubernetes injected `REDIS_PORT=tcp://...` for the `redis` Service | Already handled: `env.REDIS_PORT: "6379"` in `charts/cart/values.yaml` overrides `envFrom`. Do not remove it. |
| `shipping` restarts during startup | JVM slow start | `startupProbe.failureThreshold: 60` × 3s = 180s budget; raise it, do not shorten the liveness probe |
| PVC stuck `Pending` | `gp3` StorageClass absent or EBS CSI driver missing | `kubectl get sc gp3`; install the driver; the class is created only by the production platform values (`storageClass.enabled: true`) |
| ALB not created | AWS Load Balancer Controller missing, or subnets not tagged | Check controller logs; subnets need `kubernetes.io/role/elb=1` |
| ALB target group unhealthy | `/health` failing or NetworkPolicy blocking | `kubectl -n <ns> port-forward svc/frontend 8080:80 && curl localhost:8080/health`; confirm `allow-alb-to-frontend` exists |
| HPA shows `<unknown>/70%` | metrics-server not installed | `kubectl top pods -n <ns>` |
| Pods `Pending` in production | `nodeSelector: workload=roboshop` / toleration mismatch | Label and taint the node group, or override `nodeSelector: {}` |
| `exceeded quota` on upgrade | `ResourceQuota` too small for surge pods | Raise `resourceQuota.hard` in the platform env values |
| RabbitMQ `.erlang.cookie` permission errors | Volume ownership | The `volume-permissions` init container fixes it; do not remove it |
| Helm release stuck `pending-upgrade` | Interrupted upgrade | `helm rollback <rel> -n <ns>` |

Useful one-liners:

```bash
kubectl -n roboshop get pods -o wide --sort-by=.status.startTime
kubectl -n roboshop describe pod -l app=catalogue
kubectl -n roboshop logs -l app=payment --tail=200 -f
helm get values catalogue -n roboshop --all
helm get manifest catalogue -n roboshop | kubectl diff -f -
```

---

## FAQ

**Why do resources keep their bare names (`catalogue`, not `roboshop-catalogue`)?**
Because service discovery inside the application uses those exact DNS names
(`mongodb:27017`, `cart:8080`). `fullnameOverride` pins them; set
`useReleaseNamePrefix: true` if you ever need multiple copies per namespace.

**Why is `app: <name>` still in the selector?**
The pre-Helm Services, PDBs and NetworkPolicies all select on it, and selectors
are immutable. Keeping it makes the migration a no-op instead of a delete/recreate.

**Can I install one service on its own?**
Yes. Every chart is independent. It only needs `platform` (for the shared
ConfigMap, Secret and ServiceAccount) installed first.

**Why is `common` a library chart instead of a subchart?**
Library charts render nothing themselves, so there is no risk of accidentally
deploying a "common" workload, and consumers control every emitted object.

**Where did the datastore credentials go?**
Out of Git. They live in AWS Secrets Manager and are projected into
`roboshop-secrets` by External Secrets Operator or the Secrets Store CSI Driver.

**Should the datastores really run in-cluster?**
No — for production, point the shared ConfigMap at DocumentDB / RDS /
ElastiCache / Amazon MQ and set `enabled: false` on the four datastore charts.
The charts exist to preserve current behaviour and to power dev/qa.

**How do I add a new microservice?**
Copy an existing chart directory, edit `Chart.yaml` and `values*.yaml`, add the
service to the platform chart's `networkPolicies.applicationServices` and
`ingress.hosts[].paths`, and add one element to the ApplicationSet generator.
No new templates required.

**Why isn't the `frontend` proxying `/api/*`?**
It never did in this project — the ALB does path-based routing and nginx only
serves static assets. Preserved as-is.

---

## Best practices

* **One chart, one deployable unit.** No umbrella chart that couples releases.
* **Library chart for structure, values for variance.** If two charts differ
  only in data, that data belongs in `values.yaml`.
* **Never parameterise a security control.** Hardening lives in the template so
  it cannot be switched off by an environment override.
* **Selector labels are immutable** — keep `common.selectorLabels` free of
  version, chart or environment data.
* **Secrets by reference, never by value.** Charts name a Secret; a controller
  fills it.
* **Sync waves over `depends_on`.** Ordering belongs to the GitOps controller.
* **`--atomic` for manual upgrades, Git revert for GitOps rollbacks.**
* **`ignoreDifferences` on `/spec/replicas`** wherever an HPA is active.
* **Render then validate.** `helm lint` catches templating errors; kubeconform
  catches API-schema errors; Checkov catches policy errors. Run all three.
* **Pin by digest for production releases.** The CD pipeline resolves tags to
  digests; `image.digest` is supported by `common.image`.
