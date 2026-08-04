{{/*
Expand the chart name.
*/}}
{{- define "catalogue.name" -}}
{{- default .Chart.Name .Values.nameOverride -}}
{{- end }}

{{/*
Create a fully qualified application name.
*/}}
{{- define "catalogue.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride }}
{{- else }}
{{- include "catalogue.name" . }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "catalogue.labels" -}}
app: {{ include "catalogue.name" . }}
app.kubernetes.io/name: {{ include "catalogue.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/part-of: roboshop
{{- end }}

{{/*
Selector labels
*/}}
{{- define "catalogue.selectorLabels" -}}
app: {{ include "catalogue.name" . }}
{{- end }}

{{/*
Service Account Name
*/}}
{{- define "catalogue.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "catalogue.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- .Values.serviceAccount.name }}
{{- end }}
{{- end }}
