{{- define "common.service" -}}
{{- if and (.Values.enabled | default true) .Values.service.enabled -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "common.fullname" . }}
  namespace: {{ include "common.namespace" . }}
  labels:
    {{- include "common.labels" . | nindent 4 }}
  {{- if or .Values.service.annotations .Values.commonAnnotations }}
  annotations:
    {{- include "common.annotations" . | trim | nindent 4 }}
    {{- with .Values.service.annotations }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- end }}
spec:
  type: {{ .Values.service.type | default "ClusterIP" }}
  {{- if .Values.service.headless }}
  clusterIP: None
  {{- end }}
  {{- with .Values.service.sessionAffinity }}
  sessionAffinity: {{ . }}
  {{- end }}
  selector:
    {{- include "common.selectorLabels" . | nindent 4 }}
  ports:
    {{- range .Values.service.ports }}
    - name: {{ .name }}
      port: {{ .port }}
      targetPort: {{ .targetPort }}
      protocol: {{ .protocol | default "TCP" }}
      {{- with .nodePort }}
      nodePort: {{ . }}
      {{- end }}
    {{- end }}
{{- end }}
{{- end -}}
