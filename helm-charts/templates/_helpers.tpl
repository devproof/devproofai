{{/* Selector label value: devproof-<component> (matches the raw manifests,
     so deploy/dev/localhost-lb.yaml selectors keep working). */}}
{{- define "devproof.app" -}}devproof-{{ . }}{{- end }}

{{- define "devproof.image" -}}{{ .repository }}:{{ .tag }}{{- end }}

{{/* Name of the registry pull secret, or empty when registryAuth is
     unconfigured (public registry). existingSecret wins; otherwise the
     chart-managed registryAuth.secretName when a token is set. */}}
{{- define "devproof.pullSecretName" -}}
{{- if .Values.registryAuth.existingSecret -}}
{{ .Values.registryAuth.existingSecret }}
{{- else if .Values.registryAuth.token -}}
{{ .Values.registryAuth.secretName }}
{{- end -}}
{{- end }}

{{/* imagePullSecrets block for a pod spec (empty when registryAuth is off).
     Usage: {{- include "devproof.pullSecrets" $ | nindent 6 }} */}}
{{- define "devproof.pullSecrets" -}}
{{- with (include "devproof.pullSecretName" .) }}
imagePullSecrets:
  - name: {{ . }}
{{- end }}
{{- end }}

{{/* nodeSelector + tolerations from a component values block.
     Usage: {{- include "devproof.podScheduling" .Values.gateway | nindent 6 }} */}}
{{- define "devproof.podScheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{- define "devproof.gatewayNamespace" -}}{{ .Values.namespaces.gateway | default .Release.Namespace }}{{- end }}
{{- define "devproof.servingNamespace" -}}{{ .Values.namespaces.serving | default .Release.Namespace }}{{- end }}

{{/* User-facing Service. Usage:
     {{ include "devproof.service" (dict "root" $ "name" "gateway" "component" "gateway"
        "svc" .Values.gateway.service "targetPort" 4000 "namespace" (include "devproof.gatewayNamespace" $)) }} */}}
{{- define "devproof.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  namespace: {{ .namespace | default .root.Release.Namespace }}
  {{- with .svc.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  type: {{ .svc.type }}
  {{- with .svc.loadBalancerClass }}
  loadBalancerClass: {{ . }}
  {{- end }}
  selector:
    app: {{ include "devproof.app" .component }}
  ports:
    - port: {{ .svc.port }}
      targetPort: {{ .targetPort }}
      {{- if and (eq .svc.type "NodePort") .svc.nodePort }}
      nodePort: {{ .svc.nodePort }}
      {{- end }}
{{- end }}

{{/* Stable secret value: reuse the live cluster value if present (lookup),
     else the fixed value from values, else 24 random alphanumerics.
     Returns base64. Empty under `helm template` (no cluster) unless fixed. */}}
{{- define "devproof.stableSecretValue" -}}
{{- $existing := lookup "v1" "Secret" .root.Release.Namespace .secret -}}
{{- if and $existing (hasKey ($existing.data | default dict) .key) -}}
{{ index $existing.data .key }}
{{- else if .value -}}
{{ .value | b64enc }}
{{- else -}}
{{ randAlphaNum 24 | b64enc }}
{{- end -}}
{{- end }}
