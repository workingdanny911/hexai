import { Application, ApplicationExtension } from "@hexai/core";
import { WebInterfaceConfigurator } from "./web-interface-configurator";

type ExpressExtensionMethods<App extends Application> = {
    webInterface: () => WebInterfaceConfigurator<App>;
};

export class ExpressExtension<App extends Application>
    implements ApplicationExtension<ExpressExtensionMethods<App>, App>
{
    public extend(app: App): ExpressExtensionMethods<App> {
        const configurator = new WebInterfaceConfigurator(app);

        const patchTarget = app as any;

        patchTarget.webInterface = () => {
            if (app.isRunning()) {
                throw new Error(
                    "Cannot configure web interface while application is running"
                );
            }

            return configurator;
        };

        return app as any;
    }
}
