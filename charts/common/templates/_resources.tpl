{{/*
Convenience aggregate: renders the standard workload bundle for a microservice
chart. Individual charts may instead include the pieces one by one.
*/}}
{{- define "common.workload" -}}
{{- if eq (.Values.workloadKind | default "Deployment") "StatefulSet" -}}
{{ include "common.statefulset" . }}
{{- else -}}
{{ include "common.deployment" . }}
{{- end -}}
{{- end -}}
