{{- define "common.pvc" -}}
{{- if and (.Values.enabled | default true) .Values.persistence.enabled .Values.persistence.standalone (not .Values.persistence.existingClaim) -}}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ include "common.fullname" . }}-{{ .Values.persistence.name | default "data" }}
  namespace: {{ include "common.namespace" . }}
  labels:
    {{- include "common.labels" . | nindent 4 }}
  {{- with .Values.persistence.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  accessModes:
    {{- toYaml (.Values.persistence.accessModes | default (list "ReadWriteOnce")) | nindent 4 }}
  {{- if .Values.persistence.storageClass }}
  storageClassName: {{ .Values.persistence.storageClass }}
  {{- end }}
  resources:
    requests:
      storage: {{ .Values.persistence.size }}
{{- end }}
{{- end -}}
