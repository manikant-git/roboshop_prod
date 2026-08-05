{{/*
Secret helpers.

Roboshop never stores credentials in Git. Charts either:
  a) reference an EXISTING Kubernetes Secret (default), or
  b) declare an ExternalSecret (External Secrets Operator -> AWS Secrets Manager), or
  c) declare a SecretProviderClass (Secrets Store CSI Driver -> AWS Secrets Manager).
*/}}
{{- define "common.externalsecret" -}}
{{- if and (.Values.enabled | default true) .Values.externalSecret.enabled -}}
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {{ .Values.externalSecret.name | default (include "common.fullname" .) }}
  namespace: {{ include "common.namespace" . }}
  labels:
    {{- include "common.labels" . | nindent 4 }}
spec:
  refreshInterval: {{ .Values.externalSecret.refreshInterval | default "1h" }}
  secretStoreRef:
    name: {{ .Values.externalSecret.secretStoreRef.name }}
    kind: {{ .Values.externalSecret.secretStoreRef.kind | default "ClusterSecretStore" }}
  target:
    name: {{ .Values.externalSecret.targetSecretName | default (include "common.fullname" .) }}
    creationPolicy: Owner
  {{- if .Values.externalSecret.dataFrom }}
  dataFrom:
    {{- toYaml .Values.externalSecret.dataFrom | nindent 4 }}
  {{- else }}
  data:
    {{- range .Values.externalSecret.data }}
    - secretKey: {{ .secretKey }}
      remoteRef:
        key: {{ .remoteKey }}
        {{- with .remoteProperty }}
        property: {{ . }}
        {{- end }}
    {{- end }}
  {{- end }}
{{- end }}
{{- end -}}

{{- define "common.secretproviderclass" -}}
{{- if and (.Values.enabled | default true) .Values.secretsStoreCSI.enabled -}}
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: {{ .Values.secretsStoreCSI.name | default (include "common.fullname" .) }}
  namespace: {{ include "common.namespace" . }}
  labels:
    {{- include "common.labels" . | nindent 4 }}
spec:
  provider: aws
  parameters:
    objects: |
      {{- toYaml .Values.secretsStoreCSI.objects | nindent 6 }}
  {{- with .Values.secretsStoreCSI.secretObjects }}
  secretObjects:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- end -}}
