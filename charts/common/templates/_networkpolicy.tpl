{{- define "common.networkpolicy" -}}
{{- if and (.Values.enabled | default true) .Values.networkPolicy.enabled -}}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "common.fullname" . }}
  namespace: {{ include "common.namespace" . }}
  labels:
    {{- include "common.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      app: {{ include "common.fullname" . }}
  policyTypes:
    {{- if .Values.networkPolicy.ingress }}
    - Ingress
    {{- end }}
    {{- if .Values.networkPolicy.egress }}
    - Egress
    {{- end }}
  {{- with .Values.networkPolicy.ingress }}
  ingress:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.networkPolicy.egress }}
  egress:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- end -}}
