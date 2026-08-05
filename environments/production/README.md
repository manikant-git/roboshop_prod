# production

Namespace: `roboshop`

Install everything:

```bash
make install ENV=production
```

Install a single service:

```bash
helm upgrade --install catalogue charts/catalogue \
  -n roboshop --create-namespace \
  -f environments/production/global-values.yaml \
  -f charts/catalogue/values-production.yaml
```
