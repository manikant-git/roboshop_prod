{{- define "platform.labels" -}}
app.kubernetes.io/part-of: roboshop
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: platform
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
roboshop.io/environment: {{ .Values.environment | quote }}
{{- end -}}

{{- define "platform.namespace" -}}
{{- default .Release.Namespace .Values.namespace -}}
{{- end -}}

{{- define "platform.albTags" -}}
{{- $pairs := list -}}
{{- range $k, $v := .Values.ingress.alb.tags -}}
{{- $pairs = append $pairs (printf "%s=%s" $k $v) -}}
{{- end -}}
{{- join "," $pairs -}}
{{- end -}}
