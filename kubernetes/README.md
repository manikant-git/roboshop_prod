# Robot Shop on EKS with the AWS Load Balancer Controller

## What is here

| File | Contents |
| --- | --- |
| `00-namespace.yaml` | Namespace, ResourceQuota, LimitRange |
| `01-config.yaml` | ConfigMap with service wiring, Secret with JWT/DB credentials |
| `10-datastores.yaml` | MongoDB, MySQL, Redis, RabbitMQ StatefulSets + Services |
| `20-microservices.yaml` | catalogue, user, cart, shipping, payment Deployments + Services |
| `25-frontend.yaml` | nginx SPA Deployment + Service (ALB target group) |
| `30-ingress.yaml` | IngressClass `alb` + internet-facing Ingress |
| `40-hpa-pdb.yaml` | HorizontalPodAutoscalers and PodDisruptionBudgets |
| `50-networkpolicy.yaml` | Default-deny plus the required allow rules |

## Prerequisites

1. EKS cluster with an OIDC provider.
2. AWS Load Balancer Controller:
   ```bash
   eksctl create iamserviceaccount \
     --cluster <cluster> --namespace kube-system --name aws-load-balancer-controller \
     --attach-policy-arn arn:aws:iam::<account>:policy/AWSLoadBalancerControllerIAMPolicy \
     --approve

   helm repo add eks https://aws.github.io/eks-charts
   helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
     -n kube-system --set clusterName=<cluster> \
     --set serviceAccount.create=false \
     --set serviceAccount.name=aws-load-balancer-controller
   ```
3. Public subnets tagged `kubernetes.io/role/elb=1`, private subnets tagged
   `kubernetes.io/role/internal-elb=1`.
4. EBS CSI driver plus a `gp3` StorageClass (the StatefulSets reference it).
5. metrics-server for the HPAs.

## Before you apply

- Replace the placeholder JWT secrets in `01-config.yaml`. Generate them with
  `openssl rand -base64 48`. For production use the Secrets Store CSI driver or
  External Secrets instead of a committed Secret.
- Replace `alb.ingress.kubernetes.io/certificate-arn` and `host:` in
  `30-ingress.yaml`. To smoke test over plain HTTP, delete the
  `certificate-arn`, `ssl-redirect` and `ssl-policy` annotations and set
  `listen-ports` to `[{"HTTP":80}]`.
- Point the images at your own registry (ECR) via `kustomization.yaml`.

## Deploy

```bash
kubectl apply -k kubernetes/
kubectl -n roboshop rollout status deploy/frontend
kubectl -n roboshop get ingress roboshop   # ADDRESS is the ALB DNS name
```

## Traffic path

```text
client -> ALB (443, ACM cert) -> target group (pod IP :8080)
      -> frontend nginx -> /            SPA static files + html5 fallback
                        -> /api/user/*      user:8080
                        -> /api/catalogue/* catalogue:8080
                        -> /api/cart/*      cart:8080
                        -> /api/shipping/*  shipping:8080
                        -> /api/payment/*   payment:8080
```

The ALB health check hits `/health` on the frontend pods, which nginx answers
locally without touching a backend, so a single failing microservice never
takes the whole target group out of service.

## Notes

- All application pods run as non-root with `readOnlyRootFilesystem`, dropped
  capabilities and the RuntimeDefault seccomp profile.
- Rolling updates use `maxUnavailable: 0`; combined with the PDBs and the
  30 second deregistration delay, deploys and node drains are connection safe.
- The datastores here are for demos. In production use DocumentDB, RDS,
  ElastiCache and Amazon MQ, and delete `10-datastores.yaml`.
- The `ratings` service is not part of this repository; nginx answers
  `/api/ratings/*` with `501` and the SPA degrades gracefully.
