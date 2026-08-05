# ArgoCD / GitOps

## Layout

```
argocd/
  projects/         AppProject - repo, destination and RBAC guardrails
  applications/     app-of-apps root Application, one per environment
  applicationsets/  ApplicationSet that fans out to one Application per chart
```

## Bootstrap

```bash
kubectl apply -f argocd/projects/roboshop-project.yaml
kubectl apply -f argocd/applications/root-dev.yaml        # or qa/staging/production
```

## Sync waves

| Wave | Contents                                                        |
|------|-----------------------------------------------------------------|
| -10..-7 | Namespace, quota, limit range, storage class, SA, config, secrets, network policies (inside the platform chart) |
| -1   | `platform` chart                                                  |
| 0    | `mongodb`, `mysql`, `redis`, `rabbitmq`                           |
| 1    | `catalogue`, `user`, `cart`, `shipping`, `payment`                |
| 2    | `frontend`                                                        |
| 5    | Shared ALB Ingress (inside the platform chart, after backends)    |

ArgoCD only starts a wave once every resource in the previous wave is Healthy,
so datastores are ready before the APIs that connect to them, and target groups
exist before the ALB registers them.

## Environment policy

| Environment | Auto-sync | Prune | Self-heal |
|-------------|-----------|-------|-----------|
| dev         | yes       | yes   | yes       |
| qa          | yes       | yes   | yes       |
| staging     | yes       | no    | no        |
| production  | no (manual/PR-gated) | no | no |

`/spec/replicas` is in `ignoreDifferences` so HPA scaling never shows as drift.
