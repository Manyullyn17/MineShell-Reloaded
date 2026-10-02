package net.minecraftforge.fml.common; import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE) public @interface Mod {
  String value() default ""; String modid() default ""; String name() default ""; String version() default ""; String dependencies() default "";
  @Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD) @interface EventHandler {} }