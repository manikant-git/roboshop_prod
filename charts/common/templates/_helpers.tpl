{{/*
Common naming helpers.
*/}}
{{- define "common.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fullname. Roboshop keeps release-independent resource names so that in-cluster
DNS (mongodb, catalogue, cart ...) stays identical to the pre-Helm manifests.
Set fullnameOverride: "" and useReleaseNamePrefix: true to opt into the
standard Helm <release>-<chart> naming.
*/}}
{{- define "common.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if .Values.useReleaseNamePrefix -}}
{{- printf "%s-%s" .Release.Name (include "common.name" .) | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "common.name" . -}}
{{- end -}}
{{- end -}}

{{- define "common.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "common.namespace" -}}
{{- default .Release.Namespace .Values.namespace -}}
{{- end -}}

{{/*
Selector labels. IMPORTANT: `app: <name>` is preserved from the original
manifests because Services, NetworkPolicies and PDBs all select on it.
Selector labels must never contain version/chart data (immutable field).
*/}}
{{- define "common.selectorLabels" -}}
app: {{ include "common.fullname" . }}
app.kubernetes.io/name: {{ include "common.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "common.labels" -}}
{{ include "common.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | default .Chart.Version | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: roboshop
app.kubernetes.io/component: {{ .Values.component | default "service" }}
helm.sh/chart: {{ include "common.chart" . }}
{{- with .Values.environment }}
roboshop.io/environment: {{ . | quote }}
{{- end }}
{{- with .Values.extraLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "common.annotations" -}}
{{- with .Values.commonAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "common.image" -}}
{{- $img := .Values.image -}}
{{- $registry := $img.registry | default "" -}}
{{- $tag := $img.tag | default .Chart.AppVersion -}}
{{- if $img.digest -}}
{{- if $registry }}{{ printf "%s/%s@%s" $registry $img.repository $img.digest }}{{ else }}{{ printf "%s@%s" $img.repository $img.digest }}{{ end -}}
{{- else -}}
{{- if $registry }}{{ printf "%s/%s:%s" $registry $img.repository $tag }}{{ else }}{{ printf "%s:%s" $img.repository $tag }}{{ end -}}
{{- end -}}
{{- end -}}

{{- define "common.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "common.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Hardened pod-level security context. Security posture is intentionally NOT
parameterized; only the UID/GID (image dependent) and fsGroup are.
*/}}
{{- define "common.podSecurityContext" -}}
{{- if ne (.Values.podSecurityContext.runAsNonRoot | toString) "false" }}
runAsNonRoot: true
{{- end }}
{{- with .Values.podSecurityContext.runAsUser }}
runAsUser: {{ . }}
{{- end }}
{{- with .Values.podSecurityContext.runAsGroup }}
runAsGroup: {{ . }}
{{- end }}
{{- with .Values.podSecurityContext.fsGroup }}
fsGroup: {{ . }}
{{- end }}
{{- with .Values.podSecurityContext.fsGroupChangePolicy }}
fsGroupChangePolicy: {{ . }}
{{- end }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "common.containerSecurityContext" -}}
allowPrivilegeEscalation: false
privileged: false
readOnlyRootFilesystem: {{ .Values.containerSecurityContext.readOnlyRootFilesystem | default false }}
{{- with .Values.containerSecurityContext.runAsUser }}
runAsUser: {{ . }}
{{- end }}
{{- with .Values.containerSecurityContext.runAsGroup }}
runAsGroup: {{ . }}
{{- end }}
capabilities:
  drop:
    - ALL
{{- end -}}

{{/*
Environment variables:
  env:            plain map  key -> value
  envFromConfigMapKeys: list of { name, configMap, key }
  envFromSecretKeys:    list of { name, secret, key }
  envFrom:        list of { configMapRef | secretRef }
*/}}
{{- define "common.env" -}}
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- range .Values.envFromConfigMapKeys }}
- name: {{ .name }}
  valueFrom:
    configMapKeyRef:
      name: {{ .configMap }}
      key: {{ .key }}
{{- end }}
{{- range .Values.envFromSecretKeys }}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
{{- end }}
{{- end -}}

{{- define "common.envFrom" -}}
{{- range .Values.envFrom }}
{{- if .configMapRef }}
- configMapRef:
    name: {{ .configMapRef.name }}
{{- end }}
{{- if .secretRef }}
- secretRef:
    name: {{ .secretRef.name }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "common.probes" -}}
{{- with .Values.startupProbe }}
startupProbe:
{{ toYaml . | indent 2 }}
{{- end }}
{{- with .Values.readinessProbe }}
readinessProbe:
{{ toYaml . | indent 2 }}
{{- end }}
{{- with .Values.livenessProbe }}
livenessProbe:
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}

{{- define "common.scheduling" -}}
{{- with .Values.nodeSelector }}
nodeSelector:
{{ toYaml . | indent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
{{ toYaml . | indent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
{{ toYaml . | indent 2 }}
{{- end }}
{{- if .Values.topologySpreadConstraints.enabled }}
topologySpreadConstraints:
  - maxSkew: {{ .Values.topologySpreadConstraints.maxSkew | default 1 }}
    topologyKey: {{ .Values.topologySpreadConstraints.topologyKey | default "topology.kubernetes.io/zone" }}
    whenUnsatisfiable: {{ .Values.topologySpreadConstraints.whenUnsatisfiable | default "ScheduleAnyway" }}
    labelSelector:
      matchLabels:
        app: {{ include "common.fullname" . }}
{{- end }}
{{- end -}}

{{- define "common.podAnnotations" -}}
{{- with .Values.podAnnotations }}
{{- toYaml . }}
{{- end }}
{{- end -}}
