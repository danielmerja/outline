import Router from "koa-router";
import { IntegrationService, IntegrationType } from "@shared/types";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { transaction } from "@server/middlewares/transaction";
import validate from "@server/middlewares/validate";
import { IntegrationAuthentication, Integration, Team } from "@server/models";
import { APIContext } from "@server/types";
import { GitHubUtils } from "../../shared/GitHubUtils";
import { GitHubUser } from "../github";
import * as T from "./schema";

const router = new Router();

router.get(
  "github.callback",
  auth({
    optional: true,
  }),
  validate(T.GitHubCallbackSchema),
  transaction(),
  async (ctx: APIContext<T.GitHubCallbackReq>) => {
    const {
      code,
      state: teamId,
      error,
      installation_id: installationId,
      setup_action: setupAction,
    } = ctx.input.query;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    if (error) {
      ctx.redirect(GitHubUtils.errorUrl(error));
      return;
    }

    if (setupAction === T.SetupAction.request) {
      ctx.redirect(GitHubUtils.installRequestUrl());
      return;
    }

    // this code block accounts for the root domain being unable to
    // access authentication for subdomains. We must forward to the appropriate
    // subdomain to complete the oauth flow
    if (!user) {
      if (teamId) {
        try {
          const team = await Team.findByPk(teamId, {
            rejectOnEmpty: true,
            transaction,
          });
          return ctx.redirectOnClient(
            GitHubUtils.callbackUrl({
              baseUrl: team.url,
              params: ctx.request.querystring,
            })
          );
        } catch (err) {
          Logger.error(`Error fetching team for teamId: ${teamId}!`, err);
          return ctx.redirect(GitHubUtils.errorUrl("unauthenticated"));
        }
      } else {
        return ctx.redirect(GitHubUtils.errorUrl("unauthenticated"));
      }
    }

    const githubUser = new GitHubUser({ code: code!, state: teamId });

    let installation;
    try {
      installation = await githubUser.getInstallation(installationId!);
    } catch (err) {
      Logger.error("Failed to fetch GitHub App installation", err);
      return ctx.redirect(GitHubUtils.errorUrl("unauthenticated"));
    }

    const authentication = await IntegrationAuthentication.create(
      {
        service: IntegrationService.GitHub,
        userId: user.id,
        teamId: user.teamId,
      },
      { transaction }
    );
    await Integration.create(
      {
        service: IntegrationService.GitHub,
        type: IntegrationType.Embed,
        userId: user.id,
        teamId: user.teamId,
        authenticationId: authentication.id,
        settings: {
          github: {
            installation: {
              id: installationId!,
              account: {
                id: installation.account?.id,
                name:
                  // @ts-expect-error Property 'login' does not exist on type
                  installation.account?.login,
                avatarUrl: installation.account?.avatar_url,
              },
            },
          },
        },
      },
      { transaction }
    );
    ctx.redirect(GitHubUtils.url);
  }
);

export default router;
