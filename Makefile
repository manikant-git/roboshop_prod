# Roboshop Helm - developer entry points.
ENV      ?= dev
NS       ?= $(shell awk '/^namespace:/{print $$2}' environments/$(ENV)/global-values.yaml)
CHARTS   := platform mongodb mysql redis rabbitmq catalogue user cart shipping payment frontend
RELEASE  ?=

.PHONY: deps lint template validate scan package install uninstall diff status rollback

deps:
	@for c in common $(CHARTS); do helm dependency build charts/$$c >/dev/null; done

lint: deps
	./ci/lint.sh

template: deps
	./ci/template.sh

validate: template
	./ci/validate.sh

scan: template
	./ci/security-scan.sh

package: deps
	./ci/package.sh

# Install / upgrade the whole environment in sync-wave order.
install: deps
	@for c in $(CHARTS); do \
	  echo "==> $$c ($(ENV) -> $(NS))"; \
	  helm upgrade --install $$c charts/$$c \
	    --namespace $(NS) --create-namespace \
	    -f environments/$(ENV)/global-values.yaml \
	    -f charts/$$c/values-$(ENV).yaml \
	    --wait --timeout 10m; \
	done

diff: deps
	@for c in $(CHARTS); do \
	  helm diff upgrade $$c charts/$$c -n $(NS) \
	    -f environments/$(ENV)/global-values.yaml \
	    -f charts/$$c/values-$(ENV).yaml || true; \
	done

status:
	helm list -n $(NS)
	kubectl -n $(NS) get deploy,sts,svc,hpa,pdb,ingress

rollback:
	@test -n "$(RELEASE)" || (echo "RELEASE=<chart> required" && exit 1)
	helm rollback $(RELEASE) -n $(NS)

uninstall:
	@for c in $(shell echo $(CHARTS) | tr ' ' '\n' | tac | tr '\n' ' '); do \
	  helm uninstall $$c -n $(NS) --ignore-not-found; \
	done
