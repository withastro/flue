---
title: Deploy Agents on AWS
description: Run the Flue Docker image on AWS — ECS Express Mode, EC2, or ECS on Fargate — with managed Postgres for durable state.
lastReviewedAt: 2026-07-21
---

Flue's Node target is a long-running HTTP server, not a function. It holds agent sessions in process and serves streamed responses over long-lived connections, so on AWS you run it as a container service that stays up — Flue owns the server, AWS owns the platform around it.

Every option here runs the same image from [Deploy Agents with Docker](/docs/ecosystem/deploy/docker/). Build it, push it to a private repository in [Amazon ECR](https://docs.aws.amazon.com/AmazonECR/latest/userguide/), and point one of the compute options below at that image:

```bash
aws ecr create-repository --repository-name flue-agents
docker build -t flue-agents .
docker tag flue-agents:latest <account>.dkr.ecr.<region>.amazonaws.com/flue-agents:latest
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker push <account>.dkr.ecr.<region>.amazonaws.com/flue-agents:latest
```

The image binds `PORT` (the Docker guide sets `8080`); whatever you choose, the platform's port and health check must match it. The built server reads only the environment supplied at start — it does not load `.env` — so the provider key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, optional `MODEL_SPECIFIER`) and `DATABASE_URL` come from the platform's secret store, never the image.

Three compute options follow, ordered by how much of the platform AWS manages for you.

## ECS Express Mode (recommended)

[Amazon ECS Express Mode](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html) is the managed path: one API call takes a container image and two IAM roles and provisions a complete stack in your account — an ECS service on Fargate, an Application Load Balancer with health checks, CPU-based auto scaling, security groups, and a service URL. There is no extra charge; you pay for the underlying resources.

```bash
aws ecs create-express-gateway-service \
  --service-name flue-agents \
  --execution-role-arn arn:aws:iam::<account>:role/ecsTaskExecutionRole \
  --infrastructure-role-arn arn:aws:iam::<account>:role/ecsInfrastructureRoleForExpressServices \
  --primary-container '{
    "image": "<account>.dkr.ecr.<region>.amazonaws.com/flue-agents:latest",
    "containerPort": 8080,
    "environment": [{ "name": "MODEL_SPECIFIER", "value": "anthropic/claude-sonnet-4-6" }]
  }' \
  --health-check-path /health \
  --scaling-target '{"minTaskCount":1,"maxTaskCount":4}' \
  --monitor-resources
```

| Concern         | Express Mode                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Image           | `--primary-container image` points at the ECR repository; the **execution role** pulls it.                                                                                                                                                                                                                                     |
| Env and secrets | Plaintext vars go in `environment`. Inject secrets as a task `secrets` reference resolved by the execution role from [Secrets Manager or SSM Parameter Store](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data-secrets.html) — keep the provider key and `DATABASE_URL` out of the image. |
| Health check    | `--health-check-path` is the ALB target-group path. Flue does not generate one — define `/health` in `app.ts`.                                                                                                                                                                                                                 |
| Scaling         | `--scaling-target` sets `minTaskCount` / `maxTaskCount`; scaling tracks CPU. Keep `minTaskCount` ≥ 1 so a process is always up to hold sessions.                                                                                                                                                                               |

The ALB sits in front of long-lived conversation `GET` reads (long-poll/SSE). Raise the target group's idle timeout, and retain the admission's `streamUrl` and `offset` so clients can reconnect and resume the conversation stream. Multiple tasks need shared Postgres for durable state, but each agent instance must still be routed to one live task; do not round-robin the same instance. See the [Streaming Protocol](/docs/reference/streaming-protocol/).

## EC2 (simplest, full control)

A single instance is the most direct "your own box," and the most ops you own. Run the image with Docker:

```bash
docker run -d --restart unless-stopped -p 80:8080 \
  -e ANTHROPIC_API_KEY=sk-... \
  -e MODEL_SPECIFIER=anthropic/claude-sonnet-4-6 \
  <account>.dkr.ecr.<region>.amazonaws.com/flue-agents:latest
```

Or skip the container and run the Node build directly under systemd — build to `dist/server.mjs` with `npx vite build` (the `flue()` plugin in `vite.config.ts`) and start it with `node dist/server.mjs`:

```ini
# /etc/systemd/system/flue.service
[Service]
WorkingDirectory=/opt/flue-agents
ExecStart=/usr/bin/node dist/server.mjs
Environment=PORT=8080
EnvironmentFile=/etc/flue-agents.env
Restart=always

[Install]
WantedBy=multi-user.target
```

| Concern         | EC2                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env and secrets | systemd `EnvironmentFile` (mode `600`) or `docker run -e`. Pull the provider key and `DATABASE_URL` from SSM Parameter Store on boot rather than committing them to the instance. |
| Health check    | Nothing checks the process for you. If you front it with an ALB or run a watcher, point it at `/health` (define the route in `app.ts`).                                           |
| Port and TLS    | The instance's **security group** must open the listening port. Terminate TLS at a reverse proxy on the box (nginx / Caddy) or behind an ALB; the Node server speaks plain HTTP.  |

There is no second instance to fail over to and no autoscaling — one process holds all sessions. Long-lived conversation streams work directly; if an ALB is in front, raise its idle timeout. In-memory state is lost when the process restarts; add shared Postgres before you scale past one box.

## ECS on Fargate (orchestrated)

When you need explicit control over networking and scaling, define the task and service yourself rather than letting Express Mode generate them. A [task definition](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definitions.html) references the ECR image and injects configuration; an ECS service runs it on Fargate behind an ALB in your VPC.

In the container definition, `environment` carries plaintext vars and `secrets` (each `{ "name", "valueFrom" }`) resolves Secrets Manager ARNs or SSM parameters through the task **execution role** — that is where the provider key and `DATABASE_URL` belong. The service's `loadBalancers` block maps the container port to an ALB target group; because Fargate uses `awsvpc` networking, the target group must use the **IP** target type, and its health check path should be `/health` (defined in `app.ts`). Open the task security group to the ALB on the container port, and set `healthCheckGracePeriodSeconds` longer than the server's startup so a slow boot is not killed mid-start.

Application Auto Scaling adjusts the desired task count; raise the ALB idle timeout for streamed conversations, use shared Postgres for durable state, and route each agent instance to one live task. This is the same Fargate-plus-ALB stack Express Mode builds automatically — reach for it when you need to own the pieces.

## Persistence

Without a `db.ts` adapter, Flue keeps canonical conversations, attachments, and accepted submissions in process-local memory — lost on restart or redeploy and unavailable to replacement tasks. For durable state, back it with [Amazon RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html) reachable from the service's VPC. Shared storage supports replacement recovery; it does not enable active-active ownership of one agent instance.

Add the adapter and a `db.ts` that wraps your configured `pg` pool and reads `DATABASE_URL` — see [Postgres](/docs/ecosystem/databases/postgres/) for the full bring-your-own-driver runner:

```typescript title="src/db.ts (abridged)"
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    /* one checked-out client per transaction; see the Postgres guide */
  },
  close: () => pool.end(),
});
```

Store the RDS connection string in Secrets Manager and inject it as `DATABASE_URL` — as a task `secrets` reference on Express Mode and Fargate, or from SSM on EC2. Flue discovers `db.ts` at build time and wires it into the generated server; the adapter handles schema creation, canonical conversation streams, immutable attachments, and durable submission state.

## Not AWS Lambda

Flue does not target Lambda. The Node server is long-running and stateful — it holds agent sessions and an in-process coordinator, and serves streamed responses over long-lived conversation `GET` connections. Lambda's stateless, short-lived invocation model fits none of that: there is no durable process to hold sessions between calls, and the execution window does not suit open streams. Running Flue there would require an adapter that externalizes all coordination, which is out of scope — the same reasoning that puts function platforms like Vercel and Netlify out of scope. Use one of the container services above.

## References

- [Amazon ECS Express Mode overview](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html) and the [`create-express-gateway-service` CLI reference](https://docs.aws.amazon.com/cli/latest/reference/ecs/create-express-gateway-service.html) — the recommended path and its exact parameters.
- [Migrating from App Runner to ECS Express Mode](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html) — AWS's official guidance after App Runner closed to new customers (2026-04-30).
- [Use load balancing with an Amazon ECS service](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/create-load-balancer.html) — Fargate `awsvpc` → IP target groups, `loadBalancers`, and health-check grace periods.
- [Push an image to Amazon ECR](https://docs.aws.amazon.com/AmazonECR/latest/userguide/what-is-ecr.html) and [Amazon RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html) — the image registry and managed Postgres for `DATABASE_URL`.
