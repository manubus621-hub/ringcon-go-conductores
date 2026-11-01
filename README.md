# Ringcon Go · Conductores y administración

- `index.html`: panel de conductores. Pantalla completa, switch En línea/Offline con presencia en
  tiempo real, toma de pedidos y flujo Aceptado → En el local → Retirado → Entregado.
- `admin.html`: padrón de conductores habilitados, revisión de identidad y control de pedidos.

El backend (reglas y Cloud Functions) está en la carpeta `firebase/` de
[ringcon-go-app](https://github.com/manubus621-hub/ringcon-go-app). `js/config.js` tiene que ser igual en los dos repos.

## Cómo se verifica a un conductor

1. **Padrón:** desde `admin.html` cargás a cada conductor habilitado con DNI, nombre, apellido,
   fecha de nacimiento, vehículo, patente y vencimiento de licencia, tal como figuran en sus documentos.
2. **DNI:** el conductor escribe su DNI. La app lo busca en el padrón y le muestra el nombre
   enmascarado (C••••• L••••) para que confirme que es él sin exponer datos a terceros.
3. **Identidad:** confirma apellido y fecha de nacimiento, con un límite de 5 intentos por DNI por día,
   y crea su contraseña. Desde ese momento entra con **DNI + contraseña**.
4. **Fotos:** sube DNI frente, DNI dorso y selfie. Se comprimen en el teléfono y se guardan en
   Storage, donde solo él las puede escribir.
5. **Revisión:** en `admin.html` comparás las fotos con el padrón y aprobás o pedís fotos nuevas.
   Recién aprobado y con la licencia vigente puede ponerse en línea y tomar pedidos.

Si un conductor olvida su contraseña, restablecela desde Firebase Console → Authentication. Su usuario
es `<DNI>@conductores.ringcongo.app`.

## Cobros en efectivo

En cada pedido en efectivo el conductor ve cuánto cobra en la puerta, cuánto le paga al local al
retirar, su ganancia (envío + propina) y cuánto rinde a Ringcon Go (la comisión de servicio).
El resumen del día aparece arriba del panel. Los pedidos pagados con tarjeta muestran el aviso
de **no cobrar nada en la puerta**.
