package mstest.legacy; import net.minecraftforge.fml.common.Mod;
@Mod(modid = "mstest_clientcode", name = "MineShell Test ClientCode", version = "1.0")
public class ClientCode { @Mod.EventHandler public void preInit(net.minecraftforge.fml.common.event.FMLPreInitializationEvent e) { Object o = net.minecraft.client.Minecraft.class; System.out.println(o); } }