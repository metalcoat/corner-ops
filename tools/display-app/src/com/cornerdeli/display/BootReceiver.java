package com.cornerdeli.display;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Opens the display when the TV starts up (and after an app update). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(open);
    }
}
