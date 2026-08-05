{{- define "common.deployment" -}}
{{- if .Values.enabled | default true -}}
apiVersion: apps/v1
kind: Deployment
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
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  revisionHistoryLimit: {{ .Values.revisionHistoryLimit | default 5 }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: {{ .Values.rollingUpdate.maxUnavailable | default 0 }}
      maxSurge: {{ .Values.rollingUpdate.maxSurge | default 1 }}
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
{{- end }}
{{- end -}}
