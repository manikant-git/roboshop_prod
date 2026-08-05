# dev

Namespace: `roboshop-dev`

Install everything:

```bash
make install ENV=dev
```

Install a single service:

```bash
helm upgrade --install catalogue charts/catalogue \
  -n roboshop-dev --create-namespace \
  -f environments/dev/global-values.yaml \
  -f charts/catalogue/values-dev.yaml
```
