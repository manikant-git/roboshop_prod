{{- define "common.statefulset" -}}
{{- if .Values.enabled | default true -}}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "common.fullname" . }}
  namespace: {{ include "common.namespace" . }}
  labels:
    {{- include "common.labels" . | nindent 4 }}
  {{- $ann := include "common.annotations" . }}
  {{- if trim $ann }}
  annotations:
    {{- $ann | trim | nindent 4 }}
  {{- end }}
spec:
  serviceName: {{ include "common.fullname" . }}
  replicas: {{ .Values.replicaCount }}
  podManagementPolicy: {{ .Values.podManagementPolicy | default "OrderedReady" }}
  updateStrategy:
    type: RollingUpdate
  selector:
    matchLabels:
      {{- include "common.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "common.selectorLabels" . | nindent 8 }}
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      {{- $pann := include "common.podAnnotations" . }}
      {{- if trim $pann }}
      annotations:
        {{- $pann | trim | nindent 8 }}
      {{- end }}
    spec:
      {{- include "common.podSpec" . | nindent 6 }}
  {{- if and .Values.persistence.enabled (not .Values.persistence.existingClaim) }}
  volumeClaimTemplates:
    - metadata:
        name: {{ .Values.persistence.name | default "data" }}
        labels:
          {{- include "common.labels" . | nindent 10 }}
      spec:
        accessModes:
          {{- toYaml (.Values.persistence.accessModes | default (list "ReadWriteOnce")) | nindent 10 }}
        {{- if .Values.persistence.storageClass }}
        storageClassName: {{ .Values.persistence.storageClass }}
        {{- end }}
        resources:
          requests:
            storage: {{ .Values.persistence.size }}
  {{- end }}
{{- end }}
{{- end -}}
