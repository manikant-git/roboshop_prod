# qa

Namespace: `roboshop-qa`

Install everything:

```bash
make install ENV=qa
```

Install a single service:

```bash
helm upgrade --install catalogue charts/catalogue \
  -n roboshop-qa --create-namespace \
  -f environments/qa/global-values.yaml \
  -f charts/catalogue/values-qa.yaml
```
