{{- define "common.configmap" -}}
{{- if and (.Values.enabled | default true) .Values.configMap.enabled -}}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Values.configMap.name | default (printf "%s-config" (include "common.fullname" .)) }}
  namespace: {{ include "common.namespace" . }}
  labels:
    {{- include "common.labels" . | nindent 4 }}
data:
  {{- range $k, $v := .Values.configMap.data }}
  {{ $k }}: {{ $v | quote }}
  {{- end }}
  {{- range $k, $v := .Values.configMap.files }}
  {{ $k }}: |
{{ $v | indent 4 }}
  {{- end }}
{{- end }}
{{- end -}}
