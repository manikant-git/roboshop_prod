{{/*
Single application container, shared by Deployment and StatefulSet.
*/}}
{{- define "common.container" -}}
- name: {{ include "common.name" . }}
  image: {{ include "common.image" . | quote }}
  imagePullPolicy: {{ .Values.image.pullPolicy | default "IfNotPresent" }}
  {{- with .Values.command }}
  command: {{ toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.args }}
  args: {{ toYaml . | nindent 4 }}
  {{- end }}
  ports:
    {{- range .Values.containerPorts }}
    - name: {{ .name }}
      containerPort: {{ .containerPort }}
      protocol: {{ .protocol | default "TCP" }}
    {{- end }}
  {{- $envFrom := include "common.envFrom" . }}
  {{- if trim $envFrom }}
  envFrom:
    {{- $envFrom | trim | nindent 4 }}
  {{- end }}
  {{- $env := include "common.env" . }}
  {{- if trim $env }}
  env:
    {{- $env | trim | nindent 4 }}
  {{- end }}
  resources:
    {{- toYaml .Values.resources | nindent 4 }}
  {{- include "common.probes" . | trim | nindent 2 }}
  {{- with .Values.lifecycle }}
  lifecycle:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  securityContext:
    {{- include "common.containerSecurityContext" . | trim | nindent 4 }}
  {{- $mounts := concat (.Values.volumeMounts | default list) (include "common.persistenceMounts" . | fromYamlArray) }}
  {{- if $mounts }}
  volumeMounts:
    {{- toYaml $mounts | nindent 4 }}
  {{- end }}
{{- end -}}

{{- define "common.persistenceMounts" -}}
{{- if and .Values.persistence.enabled .Values.persistence.mountPath }}
- name: {{ .Values.persistence.name | default "data" }}
  mountPath: {{ .Values.persistence.mountPath }}
{{- else }}
[]
{{- end }}
{{- end -}}

{{/*
Shared pod spec body (everything under template.spec).
*/}}
{{- define "common.podSpec" -}}
serviceAccountName: {{ include "common.serviceAccountName" . }}
automountServiceAccountToken: {{ .Values.serviceAccount.automount | default false }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
securityContext:
  {{- include "common.podSecurityContext" . | trim | nindent 2 }}
{{- include "common.scheduling" . }}
{{- with .Values.initContainers }}
initContainers:
  {{- toYaml . | nindent 2 }}
{{- end }}
containers:
  {{- include "common.container" . | nindent 2 }}
  {{- with .Values.extraContainers }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds | default 30 }}
{{- with .Values.volumes }}
volumes:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
