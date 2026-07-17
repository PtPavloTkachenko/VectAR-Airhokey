// VectorRim v2 - INVERTED + much softer fresnel
input_color4 rimTint = color4(0.35, 1.0, 0.5, 1.0);
input_float rimEdge0 = 0.05;
input_float rimEdge1 = 0.95;
input_float rimBoost = 0.9;

void main() {
    vec3 nObj = system.getSurfaceNormalObjectSpace();
    vec3 nWorld = normalize((system.getMatrixWorld() * vec4(nObj, 0.0)).xyz);
    mat4 cam = system.getMatrixCamera();
    vec3 camFwd = normalize(cam[2].xyz);
    float facing = abs(dot(nWorld, camFwd));
    float rim = smoothstep(rimEdge0, rimEdge1, facing);
    rim = rim * rim; // extra soft shoulder
    vec3 col = rimTint.rgb * rim * rimBoost;
    fragColor = vec4(col, rim);
}
