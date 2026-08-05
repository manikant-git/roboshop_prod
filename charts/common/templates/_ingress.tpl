{{- define "common.ingress" -}}
{{- if and (.Values.enabled | default true) .Values.ingress.enabled -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Values.ingress.name | default (include "common.fullname" .) }}
  namespace: {{ include "common.namespace" . }}
  labels:
    {{- include "common.labels" . | nindent 4 }}
  annotations:
    {{- if eq (.Values.ingress.className | default "alb") "alb" }}
    alb.ingress.kubernetes.io/load-balancer-name: {{ .Values.ingress.alb.loadBalancerName | quote }}
    alb.ingress.kubernetes.io/scheme: {{ .Values.ingress.alb.scheme | quote }}
    alb.ingress.kubernetes.io/target-type: {{ .Values.ingress.alb.targetType | quote }}
    alb.ingress.kubernetes.io/group.name: {{ .Values.ingress.alb.groupName | quote }}
    alb.ingress.kubernetes.io/listen-ports: {{ .Values.ingress.alb.listenPorts | quote }}
    {{- if .Values.ingress.alb.certificateArn }}
    alb.ingress.kubernetes.io/certificate-arn: {{ .Values.ingress.alb.certificateArn | quote }}
    alb.ingress.kubernetes.io/ssl-policy: {{ .Values.ingress.alb.sslPolicy | quote }}
    {{- end }}
    {{- if .Values.ingress.alb.sslRedirect }}
    alb.ingress.kubernetes.io/ssl-redirect: {{ .Values.ingress.alb.sslRedirect | quote }}
    {{- end }}
    alb.ingress.kubernetes.io/healthcheck-protocol: {{ .Values.ingress.alb.healthcheck.protocol | quote }}
    alb.ingress.kubernetes.io/healthcheck-path: {{ .Values.ingress.alb.healthcheck.path | quote }}
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: {{ .Values.ingress.alb.healthcheck.intervalSeconds | quote }}
    alb.ingress.kubernetes.io/healthcheck-timeout-seconds: {{ .Values.ingress.alb.healthcheck.timeoutSeconds | quote }}
    alb.ingress.kubernetes.io/healthy-threshold-count: {{ .Values.ingress.alb.healthcheck.healthyThreshold | quote }}
    alb.ingress.kubernetes.io/unhealthy-threshold-count: {{ .Values.ingress.alb.healthcheck.unhealthyThreshold | quote }}
    alb.ingress.kubernetes.io/success-codes: {{ .Values.ingress.alb.healthcheck.successCodes | quote }}
    alb.ingress.kubernetes.io/load-balancer-attributes: {{ .Values.ingress.alb.loadBalancerAttributes | quote }}
    {{- if .Values.ingress.alb.wafv2AclArn }}
    alb.ingress.kubernetes.io/wafv2-acl-arn: {{ .Values.ingress.alb.wafv2AclArn | quote }}
    {{- end }}
    alb.ingress.kubernetes.io/tags: {{ include "common.albTags" . | quote }}
    {{- end }}
    {{- with .Values.ingress.annotations }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  ingressClassName: {{ .Values.ingress.className | default "alb" }}
  {{- with .Values.ingress.tls }}
  tls:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  rules:
    {{- range .Values.ingress.hosts }}
    - {{ if .host }}host: {{ .host | quote }}{{ end }}
      http:
        paths:
          {{- range .paths }}
          - path: {{ .path }}
            pathType: {{ .pathType | default "Prefix" }}
            backend:
              service:
                name: {{ .serviceName }}
                port:
                  number: {{ .servicePort }}
          {{- end }}
    {{- end }}
{{- end }}
{{- end -}}

{{- define "common.albTags" -}}
{{- $pairs := list -}}
{{- range $k, $v := .Values.ingress.alb.tags -}}
{{- $pairs = append $pairs (printf "%s=%s" $k $v) -}}
{{- end -}}
{{- join "," $pairs -}}
{{- end -}}
