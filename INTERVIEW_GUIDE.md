# INTERVIEW_GUIDE.md

Platform / DevOps interview preparation built entirely from this repository.
Every answer below maps to something you can point at in the code.

---

## 1. The 90-second project pitch

> "Roboshop is an 11-service e-commerce platform on EKS — six stateless
> microservices in Node, Java and Python, plus MongoDB, MySQL, Redis and
> RabbitMQ. It was ~1,300 lines of hand-maintained YAML with about 95%
> duplication across services. I Helmified it without changing runtime
> behaviour: a `type: library` chart holds every reusable template, a `platform`
> chart owns the shared namespace/quota/storage/ingress/network-policy layer,
> and each service is an independently versioned chart. Four environments are
> layered values files, GitOps is ArgoCD ApplicationSets with sync waves, and CI
> is lint → template → kubeconform → checkov → OCI push. The pipeline has no
> cluster credentials — ArgoCD pulls. The hardest constraints were immutable
> fields: I kept the `app:` selector labels and bare Service names so the
> migration was a no-op instead of a delete-and-recreate."

Then stop talking. Let them pick a thread.

---

## 2. Questions you will be asked, with answers

### Helm

**Q. Library chart vs umbrella chart — when do you use each?**
A library chart (`type: library`) renders nothing; it exports named templates
consumed via `include`. Use it for *structural* reuse across independently
released charts. An umbrella chart bundles subcharts into a single release —
use it when the components genuinely deploy and roll back as one unit. Here,
ten services must version independently, so an umbrella chart would mean a
`catalogue` image bump creates a new revision of the entire platform and
`helm rollback` reverts everything. See ADR-001.

**Q. How does values precedence work?**
Later files override earlier ones; `--set` beats all files. Ours is
`values.yaml` → `values-<env>.yaml` → `environments/<env>/global-values.yaml`.
Maps merge deeply, **lists are replaced wholesale** — that is the usual
surprise, and why `env` is a map rather than a list of `{name,value}`.

**Q. `include` vs `template`?**
`template` is an action and its output cannot be piped. `include` is a function
that returns a string, so `{{ include "common.labels" . | nindent 4 }}` works.
Always use `include` in a library chart.

**Q. Why is `$` used inside `range` in your templates?**
Inside `range`, `.` is the loop element. `$` is the root context, needed to
reach `.Values` and `.Release`. Forgetting it is the number-one library-chart
bug.

**Q. `helm upgrade --atomic` vs `--wait`?**
`--wait` blocks until resources are ready or the timeout hits, then leaves you
in a failed state. `--atomic` implies `--wait` and automatically rolls back on
failure. Use `--atomic` for manual production upgrades.

**Q. Where does Helm store release state?**
A Secret per revision in the release namespace, `sh.helm.release.v1.<name>.v<n>`,
gzipped protobuf. `helm rollback` reads the previous one. This is why a deleted
namespace loses release history.

**Q. Why not just Kustomize?**
Kustomize is excellent for patching; it has no packaging, no versioning, no
registry distribution, no release history and no conditional logic. This project
needs "install `catalogue` v2.0.1 from ECR into qa" — that is a package manager
problem. The two compose fine (ArgoCD can post-render), but Helm is the base.

### Kubernetes

**Q. Deployment vs StatefulSet — why the split here?**
StatefulSets give stable network identity (`mongodb-0` via a headless Service),
stable per-pod storage through `volumeClaimTemplates`, and ordered rollout.
Datastores need all three; stateless services need none and get faster,
unordered rolling updates instead.

**Q. Why is `volumeBindingMode: WaitForFirstConsumer` important?**
EBS volumes are zonal. With `Immediate`, the volume is provisioned before the
pod is scheduled, potentially in an AZ with no capacity for that pod — the pod
is then permanently `Pending`. Deferring binding lets the scheduler choose the
node first. This is the classic EBS-on-EKS interview question.

**Q. Liveness vs readiness vs startup probe.**
Readiness gates *traffic* (removes the pod from Service endpoints). Liveness
gates *life* (restarts the container). Startup gates *the other two* — while it
runs, liveness and readiness are suspended. Our `shipping` JVM gets a 180s
startup budget with a still-tight liveness probe, instead of a large
`initialDelaySeconds` that would permanently blunt failure detection (ADR-017).

**Q. Your HPA and ArgoCD both manage replicas. Conflict?**
Yes, and it is the most common ArgoCD bug. The HPA writes `/spec/replicas`, Git
declares a different number, ArgoCD reports OutOfSync and with self-heal on it
fights the HPA. Fix: `ignoreDifferences` on `/spec/replicas` — which is in every
Application we generate. The template also omits `replicas` entirely when
`autoscaling.enabled` is true.

**Q. Why can a PDB block a cluster upgrade?**
`minAvailable` equal to the replica count means the eviction API can never allow
a pod to leave, so `kubectl drain` hangs forever. Production runs 3 replicas
with `minAvailable: 2` — exactly one pod of headroom (ADR-016).

**Q. Explain your NetworkPolicy model.**
Default-deny ingress for the namespace, then explicit allows: DNS egress to
kube-dns on 53/UDP+TCP, ALB→frontend, ALB→backends, service↔service, and
services→datastores on 27017/3306/6379/5672. Default-deny is what stops a
compromised frontend from reaching MySQL. The classic mistake is forgetting DNS
egress — every service then fails resolution in a way that looks like an app bug.

**Q. What makes a pod spec "hardened" here?**
`runAsNonRoot`, non-zero UID/GID, `allowPrivilegeEscalation: false`,
`capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`,
`readOnlyRootFilesystem` with an `emptyDir` at `/tmp`, and
`automountServiceAccountToken: false`. All of them are literals in the library
chart, not values — a control you can switch off from a values file is not a
control (ADR-005).

**Q. Which fields are immutable, and why does it matter?**
Deployment/StatefulSet `spec.selector`, Service `spec.clusterIP` and port
identity, StatefulSet `volumeClaimTemplates`, PVC size (shrinking), Job
`spec.template`. It matters because changing one is not an upgrade — it is a
delete and recreate, i.e. downtime. That single fact drove ADR-002.

### AWS / EKS

**Q. What is IRSA and why is it better than a node instance profile?**
IRSA maps a Kubernetes ServiceAccount to an IAM role through the cluster's OIDC
provider. The kubelet projects a signed SA token, the AWS SDK exchanges it via
`AssumeRoleWithWebIdentity`, and the pod gets short-lived scoped credentials. A
node instance profile grants its permissions to *every pod on that node*, so one
compromised sidecar inherits them. IRSA also gives per-pod CloudTrail identity.

**Q. ALB `target-type: ip` vs `instance`.**
`instance` mode registers node IPs and requires `NodePort` Services, adding a
kube-proxy hop and an extra hop when the pod is on another node. `ip` mode
registers pod IPs directly with the target group — fewer hops, works with
`ClusterIP`, and is required for Fargate. It is why every Service here stays
`ClusterIP`.

**Q. What does `group.name` on an ALB Ingress do?**
It lets the AWS Load Balancer Controller merge multiple Ingress resources onto
one ALB. Without it, each Ingress is a separate ALB — six services, six ALBs,
six times the cost plus duplicated TLS/WAF/DNS config. `group.order` controls
rule precedence.

**Q. gp2 vs gp3?**
gp3 decouples IOPS and throughput from capacity (gp2 gives 3 IOPS/GB, so you
over-provision capacity to buy performance) and is roughly 20% cheaper per GB.
Ours is encrypted, expandable, `Retain` in production.

**Q. How do secrets get from AWS into pods?**
External Secrets Operator watches an `ExternalSecret`, authenticates to Secrets
Manager via IRSA, and materialises a Kubernetes Secret, re-syncing every 15
minutes. Alternative mode: Secrets Store CSI Driver mounts them as files and
never creates a Secret object. Both converge on the same Secret name, so service
charts are unaware of which is in use (ADR-006).

**Q. Why not Sealed Secrets or SOPS?**
Both keep ciphertext in Git, so rotation is a commit and a redeploy, and the
blast radius of a leaked private key is the whole history. Keeping the source of
truth in Secrets Manager gives rotation, KMS, CloudTrail and cross-account
policy for free.

### GitOps and CI/CD

**Q. Push-based CD vs pull-based GitOps.**
Push means the pipeline holds cluster credentials — a tier-0 attack path and a
source of out-of-band drift. Pull means the cluster reconciles from Git; CI only
needs repo read and registry write. It also gives continuous drift correction:
a manual `kubectl edit` gets reverted.

**Q. How do you order deployments in ArgoCD?**
Sync waves. Annotation `argocd.argoproj.io/sync-wave`; ArgoCD completes and
health-checks a wave before starting the next. Ours: `-1` platform, `0`
datastores, `1` microservices, `2` frontend, and `5` for the ALB Ingress inside
the platform chart so target groups are built after Services exist.

**Q. ApplicationSet vs writing 11 Applications?**
ApplicationSet generates them from a generator (list, git, cluster, matrix).
Eleven charts × four environments would be 44 hand-maintained YAML files that
drift. Here it is four ApplicationSets.

**Q. Walk me through your CI pipeline and what each stage catches.**
`helm dependency build` → `helm lint --strict` (template syntax, undefined
values) → `helm template` per environment (rendering failures lint misses) →
`kubeconform -strict` (wrong apiVersion, misspelled fields, deprecated APIs;
`-strict` rejects unknown fields so `resource:` instead of `resources:` fails)
→ `checkov` (policy: missing probes, missing limits, privileged containers) →
on main, `helm package` + `helm push` to ECR over OIDC. Four different failure
classes; running only one is a false sense of safety.

**Q. Why OCI registries for charts?**
Same registry, auth and lifecycle policy as container images; no separate
`index.yaml` repo to host; immutable, content-addressable artifacts; native
`helm push`/`helm pull` since Helm 3.8.

**Q. How do you promote a build from qa to production?**
Change the image tag in `charts/<svc>/values-production.yaml` via a PR. CI
validates the render, a human approves, ArgoCD's production Application is
manual-sync so a second human triggers the sync. Git is the audit log.

---

## 3. Scenario / whiteboard questions

**"A rollout is stuck; pods are `Pending`. Debug it."**
`kubectl describe pod` → read Events. Most likely: (a) insufficient CPU/memory
requests vs node capacity; (b) `nodeSelector`/taint mismatch — production pins
`workload=roboshop`; (c) PVC `Pending` because the gp3 class or EBS CSI driver
is missing; (d) `ResourceQuota` exceeded, which surge pods can trigger during an
upgrade even when steady-state fits; (e) topology spread with `DoNotSchedule`
and not enough AZs.

**"Users see 502s from the ALB. Where do you look?"**
Target group health in the AWS console first — unhealthy targets means the pods
are failing the health check path. Then readiness probes (`kubectl get
endpoints`), then NetworkPolicy (is `allow-alb-to-backend` present?), then the
`healthcheck-path` annotation, then whether the ALB security group can reach the
pod ENIs on the target port.

**"Someone `kubectl edit`ed a Deployment in production. What happens?"**
Under ArgoCD, the Application goes OutOfSync. In dev/qa self-heal reverts it
within the reconcile interval. In production self-heal is off, so it shows as
drift until a human reconciles — which is deliberate, because production changes
should be visible and reviewed rather than silently overwritten.

**"How would you add a new microservice?"**
Copy a chart directory, change `Chart.yaml` and `values*.yaml`, add it to the
platform chart's `networkPolicies.applicationServices` and to
`ingress.hosts[].paths`, and add one element to the ApplicationSet generator.
No new templates — that is the payoff of the library chart.

**"Your MySQL pod is deleted and the node is gone. What happens?"**
The StatefulSet recreates `mysql-0`; the PVC survives (it is not owned by the
pod) and the EBS volume reattaches — but only to a node in the same AZ, and
reattachment takes minutes. If the volume itself is lost, so is the data: there
is no replica and no backup. This is exactly why ADR-010 recommends RDS
Multi-AZ for production, and being able to say that unprompted is the point.

**"How would you cut cost here?"**
One ALB via IngressGroup (already done — saves 5× ALB hours), gp3 over gp2
(~20%), right-sized requests driven by observed usage rather than guesses,
Karpenter with consolidation, Spot for dev/qa node groups, scale dev to zero
overnight, and `Delete` reclaim policy in dev/qa to avoid orphaned EBS volumes.

---

## 4. Things to say that signal seniority

* "Selectors are immutable, so I kept `app:` — otherwise the migration is a
  delete and recreate, not an upgrade."
* "I hardcoded the security context rather than exposing it, because an
  overridable control gets overridden at 2am."
* "The pipeline has no cluster credentials; ArgoCD pulls."
* "`ignoreDifferences` on `/spec/replicas`, or the HPA and ArgoCD fight."
* "`WaitForFirstConsumer`, because EBS is zonal."
* "Startup probe, not a long `initialDelaySeconds`, so steady-state liveness
  detection stays tight."
* "The in-cluster datastores preserve existing behaviour, but they are
  single-replica with no backup — here is the migration path to managed
  services, and it is a ConfigMap change because every endpoint is
  externalised."

Volunteering the last one — a candid limitation with a concrete remediation —
does more for you than any answer above.

---

## 5. Rapid-fire recall

| Term | One line |
|------|----------|
| Library chart | `type: library`, renders nothing, exports templates via `include` |
| Sync wave | ArgoCD ordering annotation; next wave starts only when the previous is Healthy |
| IRSA | SA → IAM role via cluster OIDC; short-lived, per-pod credentials |
| `target-type: ip` | ALB registers pod IPs directly; needs only ClusterIP |
| IngressGroup | Merge many Ingresses onto one ALB via `group.name` |
| `WaitForFirstConsumer` | Bind the PV after scheduling, so zone and node agree |
| PDB | Caps *voluntary* disruption; `minAvailable == replicas` blocks drains |
| Startup probe | Suspends liveness/readiness during slow starts |
| ESO | Syncs AWS Secrets Manager → Kubernetes Secret on an interval |
| Default-deny | No ingress unless explicitly allowed; DNS egress must be allowed too |
| `--atomic` | `--wait` plus automatic rollback on failure |
| kubeconform | Validates rendered manifests against Kubernetes API schemas |
| Server-side apply | Field-manager-based conflict detection; no annotation size limit |
