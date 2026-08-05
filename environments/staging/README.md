# staging

Namespace: `roboshop-staging`

Install everything:

```bash
make install ENV=staging
```

Install a single service:

```bash
helm upgrade --install catalogue charts/catalogue \
  -n roboshop-staging --create-namespace \
  -f environments/staging/global-values.yaml \
  -f charts/catalogue/values-staging.yaml
```
