{{/*
Chart-local helpers. All generic helpers live in the `common` library chart
(charts/common/templates/_helpers.tpl) and are reachable from here because
`common` is declared as a dependency.
*/}}
{{- define "redis.fullname" -}}
{{- include "common.fullname" . -}}
{{- end -}}
